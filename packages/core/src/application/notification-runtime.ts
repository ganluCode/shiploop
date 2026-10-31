/**
 * P07-4 / F-008：默认通知运行时（application 层）。
 *
 * 职责（PRD 验收 1、设计 04 §5、08 §6）：
 * - 把 F-006 投影（持久水位有界扫描）与 F-007 发送驱动（短事务认领 + 事务外
 *   发送/回执）组成一个有界轮次；start 触发立即补扫，此后按 intervalMs 周期
 *   补扫——内存唤醒（wake）是可选优化，丢失唤醒由周期持久补扫补偿；
 * - quiesce 语义与 Host 活动门一致：enterQuiesce 停止新认领（此后不再开始新
 *   轮次），awaitQuiesce 在有限预算内等待在途轮次收尾；未确认时 close 拒绝，
 *   保留状态库与持久现场（不吞掉 cleanup_unconfirmed 类失败）；
 * - 维护门控：维护占用（backup/migration/restore/project_archive/project_delete）
 *   期间跳过轮次；写入事务内的最终防线由存储适配器的 assertCanWrite('notification')
 *   承担（运行时预检查只是减少无效尝试）；
 * - 本模块不触碰业务执行：不创建 Run/Attempt、不推进 Task/预算/检查，通知失败
 *   只进入结构化诊断（lastError），不抛出到 Host 生命周期。
 *
 * 纯度不变量：定时器可注入（默认 node:timers 全局）；不读文件系统/网络；
 * 时钟经由注入端口（存储/服务自带）；不建立通用事件工作流平台。
 */
import { randomUUID } from 'node:crypto';
import { StorageError } from '../ports/errors.js';
import type { MaintenanceWriteGate } from '../ports/data-maintenance.js';
import type { NotificationDeliveryService } from './notification-delivery.js';
import type { NotificationProjectionService } from './notification-projection.js';

/** 可注入定时器（与 work-scheduler 同一纪律；测试手动驱动）。 */
export interface NotificationRuntimeTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_INTERVAL_MS = 1_000 as const;
const MIN_INTERVAL_MS = 50 as const;
const MAX_INTERVAL_MS = 3_600_000 as const;

export type NotificationRuntimeSkipReason = 'quiescing' | 'closed' | 'round_active' | 'maintenance';

/** 一轮（或被跳过的轮次）的有界结果；不含业务明细，只含计数。 */
export interface NotificationRuntimeRoundResult {
  readonly skipped: boolean;
  readonly skipReason: NotificationRuntimeSkipReason | null;
  readonly eventsScanned: number;
  readonly deliveriesCreated: number;
  readonly deliveriesClaimed: number;
  readonly moreEventsAvailable: boolean;
}

/** 结构化轮次错误（脱敏：只含类别/操作/原因码，不回显事件或摘要原文）。 */
export interface NotificationRuntimeError {
  readonly kind: string;
  readonly operation: string;
  readonly reason: string;
}

export interface NotificationRuntimeStateView {
  readonly started: boolean;
  readonly quiescing: boolean;
  readonly roundInFlight: boolean;
  readonly roundsExecuted: number;
  readonly lastSkipReason: NotificationRuntimeSkipReason | null;
  readonly lastError: NotificationRuntimeError | null;
}

export interface NotificationRuntimeOptions {
  readonly projection: NotificationProjectionService;
  readonly delivery: NotificationDeliveryService;
  /** 维护占用预检查（可选；写事务内的权威门控在存储适配器）。 */
  readonly maintenanceGate?: Pick<MaintenanceWriteGate, 'read'>;
  /** 认领 owner 身份（缺省每实例随机；跨实例不共享，fencing 由代次承担）。 */
  readonly owner?: string;
  /** 周期补扫间隔（50..3_600_000 ms；默认 1_000）。 */
  readonly intervalMs?: number;
  readonly timers?: NotificationRuntimeTimers;
}

export interface NotificationRuntime {
  /** 启动周期补扫（触发一次立即补扫）；幂等；close 后拒绝。 */
  start(): void;
  /** 可选内存唤醒：立即调度一次补扫；丢失唤醒由周期补扫补偿。 */
  wake(): void;
  /** 执行一个有界轮次（受 quiesce/close/在途轮次/维护门控约束）。 */
  runOnce(): Promise<NotificationRuntimeRoundResult>;
  /** 停止新认领（此后不再开始新轮次）；返回当时在途轮次数。 */
  enterQuiesce(): { readonly accepted: number };
  /** 有限预算内等待在途轮次收尾；只有 confirmed 才允许关闭。 */
  awaitQuiesce(budgetMs: number): Promise<{ readonly confirmed: boolean; readonly pending: readonly string[] }>;
  /** 停止定时器并标记关闭；幂等；在途轮次未收尾时 conflict 拒绝。 */
  close(): void;
  isClosed(): boolean;
  state(): NotificationRuntimeStateView;
}

const SKIP_PENDING: readonly string[] = ['notification-round'];

function skipped(skipReason: NotificationRuntimeSkipReason): NotificationRuntimeRoundResult {
  return Object.freeze({
    skipped: true, skipReason, eventsScanned: 0, deliveriesCreated: 0, deliveriesClaimed: 0, moreEventsAvailable: false,
  });
}

async function observeWithin(promise: Promise<unknown>, ms: number): Promise<'settled' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      promise.then(() => 'settled' as const),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms); }),
    ]);
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createNotificationRuntime(options: NotificationRuntimeOptions): NotificationRuntime {
  if (options === null || typeof options !== 'object') throw new TypeError('createNotificationRuntime: options 必须是对象');
  if (typeof options.projection?.runProjectionRound !== 'function') throw new TypeError('createNotificationRuntime: projection 必须是 NotificationProjectionService');
  if (typeof options.delivery?.runOnce !== 'function') throw new TypeError('createNotificationRuntime: delivery 必须是 NotificationDeliveryService');
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new RangeError(`createNotificationRuntime: intervalMs 必须是 ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS} 的整数`);
  }
  const owner = options.owner ?? `notifications-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner)) throw new TypeError('createNotificationRuntime: owner 非法');
  const timers: NotificationRuntimeTimers = options.timers ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  if (options.maintenanceGate !== undefined && typeof options.maintenanceGate.read !== 'function') {
    throw new TypeError('createNotificationRuntime: maintenanceGate 缺少 read()');
  }

  let started = false;
  let quiescing = false;
  let closed = false;
  let roundsExecuted = 0;
  let lastSkipReason: NotificationRuntimeSkipReason | null = null;
  let lastError: NotificationRuntimeError | null = null;
  let timerHandle: unknown = null;
  let roundInFlight: Promise<NotificationRuntimeRoundResult> | undefined;

  function cancelTimer(): void {
    if (timerHandle !== null) {
      timers.clearTimeout(timerHandle);
      timerHandle = null;
    }
  }

  function schedule(delayMs: number): void {
    if (timerHandle !== null) return;
    timerHandle = timers.setTimeout(() => {
      timerHandle = null;
      tick();
    }, delayMs);
  }

  function recordRoundError(error: unknown): void {
    if (error instanceof StorageError) {
      if (error.kind === 'busy') lastSkipReason = 'maintenance';
      const reason = error.details?.reason;
      lastError = {
        kind: error.kind,
        operation: error.operation,
        reason: typeof reason === 'string' ? reason : 'notification_storage_rejected',
      };
      return;
    }
    lastError = { kind: 'unexpected', operation: 'NotificationRuntime.round', reason: 'notification_round_failed' };
  }

  async function beginRound(): Promise<NotificationRuntimeRoundResult> {
    let eventsScanned = 0;
    let deliveriesCreated = 0;
    let deliveriesClaimed = 0;
    let moreEventsAvailable = false;
    const completion = (async () => {
      try {
        const projected = options.projection.runProjectionRound();
        eventsScanned = projected.eventsScanned;
        deliveriesCreated = projected.deliveriesCreated;
        moreEventsAvailable = projected.moreAvailable;
      } catch (error) {
        // 投影失败不阻断发送阶段，也不抛出到生命周期；结构化留痕。
        recordRoundError(error);
      }
      try {
        const worked = await options.delivery.runOnce({ owner, channelId: 'local-results' });
        deliveriesClaimed = worked.claimedCount;
      } catch (error) {
        recordRoundError(error);
      }
      return Object.freeze({
        skipped: false, skipReason: null, eventsScanned, deliveriesCreated, deliveriesClaimed, moreEventsAvailable,
      }) satisfies NotificationRuntimeRoundResult;
    })();
    roundInFlight = completion;
    try {
      return await completion;
    } finally {
      roundInFlight = undefined;
      roundsExecuted += 1;
    }
  }

  async function runOnce(): Promise<NotificationRuntimeRoundResult> {
    if (closed) { lastSkipReason = 'closed'; return skipped('closed'); }
    if (quiescing) { lastSkipReason = 'quiescing'; return skipped('quiescing'); }
    if (roundInFlight !== undefined) return skipped('round_active');
    const occupancy = options.maintenanceGate?.read();
    if (occupancy !== undefined && occupancy.state !== 'idle') {
      lastSkipReason = 'maintenance';
      return skipped('maintenance');
    }
    return beginRound();
  }

  function tick(): void {
    if (!started || quiescing || closed) return;
    if (roundInFlight !== undefined) return;
    void runOnce().then(() => {
      // 周期补扫：上一轮完成后（未被 quiesce/close 停止）重新调度。
      if (started && !quiescing && !closed) schedule(intervalMs);
    }, () => undefined);
  }

  return Object.freeze({
    start(): void {
      if (closed) throw new StorageError('conflict', 'NotificationRuntime.start', '通知运行时已关闭，不能重新启动');
      if (!started) {
        started = true;
        // 立即补扫启动积压（丢失唤醒同理由补扫补偿）。
        schedule(0);
      }
    },
    wake(): void {
      if (!started || quiescing || closed) return;
      if (roundInFlight !== undefined || timerHandle !== null) return;
      schedule(0);
    },
    runOnce,
    enterQuiesce(): { accepted: number } {
      quiescing = true;
      cancelTimer();
      return { accepted: roundInFlight === undefined ? 0 : 1 };
    },
    async awaitQuiesce(budgetMs: number): Promise<{ confirmed: boolean; pending: readonly string[] }> {
      if (roundInFlight === undefined) return { confirmed: true, pending: [] };
      await observeWithin(roundInFlight.then(() => undefined, () => undefined), Math.max(1, budgetMs));
      // 预算内收尾：轮次完成回调先于本观察者清空在途标记（同一次序化微任务队列）。
      return roundInFlight === undefined
        ? { confirmed: true, pending: [] }
        : { confirmed: false, pending: [...SKIP_PENDING] };
    },
    close(): void {
      if (closed) return;
      if (roundInFlight !== undefined) {
        throw new StorageError('conflict', 'NotificationRuntime.close', '通知轮次尚未收尾，确认停止后才能关闭状态库');
      }
      quiescing = true;
      closed = true;
      cancelTimer();
    },
    isClosed(): boolean {
      return closed;
    },
    state(): NotificationRuntimeStateView {
      return Object.freeze({
        started, quiescing, roundInFlight: roundInFlight !== undefined, roundsExecuted, lastSkipReason, lastError,
      });
    },
  });
}
