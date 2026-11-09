/**
 * P07-4 / F-007：独立通知发送驱动。
 *
 * 认领在 SQLite 短事务内完成；渠道调用、超时、取消和回执确认全部在事务外。
 * 默认 local-results 只返回稳定回执并由 Core 持久结果表记录，不执行 shell、Webhook
 * 或桌面通知。发送器不触碰业务状态，也不启动任务重试。
 */
import {
  DEFAULT_NOTIFICATION_DELIVERY_WORKER_POLICY,
  NOTIFICATION_CHANNEL_IDS,
  type NotificationChannel,
  type NotificationChannelCancelInput,
  type NotificationChannelSendInput,
  type NotificationDeliveryAttemptResult,
  type NotificationDeliveryRecord,
  type NotificationDeliveryStore,
  type NotificationDeliveryWorkResult,
  type NotificationDeliveryWorkerPolicy,
} from '../ports/notification-delivery.js';

export interface NotificationDeliveryServiceOptions {
  readonly store: NotificationDeliveryStore;
  readonly channels?: readonly NotificationChannel[];
  readonly policy?: Partial<NotificationDeliveryWorkerPolicy>;
}

export interface NotificationDeliveryRunInput {
  readonly owner: string;
  readonly channelId?: (typeof NOTIFICATION_CHANNEL_IDS)[number];
  readonly limit?: number;
}

type TimedOut = { readonly timedOut: true };
type Completed<T> = { readonly timedOut: false; readonly value: T };

function validatePolicy(input: Partial<NotificationDeliveryWorkerPolicy>): NotificationDeliveryWorkerPolicy {
  const policy = { ...DEFAULT_NOTIFICATION_DELIVERY_WORKER_POLICY, ...input };
  for (const [field, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`通知工作策略 ${field} 必须是正整数`);
  }
  if (policy.batchSize > 100 || policy.maxConcurrent > 16 || policy.sendTimeoutMs > 300_000 || policy.cancellationTimeoutMs > 60_000) {
    throw new RangeError('通知工作策略超出有界上限');
  }
  if (policy.maxConcurrent > policy.batchSize) throw new RangeError('通知并发不能大于批大小');
  return policy;
}

async function withinTimeout<T>(operation: () => Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<Completed<T> | TimedOut> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const operationPromise = operation();
  const timeoutPromise = new Promise<TimedOut>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([operationPromise.then(result => ({ timedOut: false as const, value: result })), timeoutPromise]);
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Promise.race attaches rejection handling to operationPromise. A late result is
    // deliberately ignored after timeout; the claim remains fenced until confirmed.
    void timedOut;
  }
}

function failedResult(delivery: NotificationDeliveryRecord, outcome: NotificationDeliveryAttemptResult['outcome'], reason: string): NotificationDeliveryAttemptResult {
  const status: NotificationDeliveryAttemptResult['status'] = delivery.status === 'delivered' ? 'delivered'
    : delivery.status === 'exhausted' ? 'exhausted'
      : delivery.status === 'retry_scheduled' ? 'retry_scheduled' : 'in_flight';
  return { deliveryId: delivery.deliveryId, attempt: delivery.attemptCount, status, outcome, failureReason: reason };
}

export function createLocalResultsChannel(): NotificationChannel {
  return Object.freeze({
    channelId: 'local-results' as const,
    async send(input: NotificationChannelSendInput): Promise<Readonly<Record<string, unknown>>> {
      if (input.signal.aborted) throw new Error('cancelled');
      // The receipt is deterministic. The SQLite store is the local result channel.
      return { channelId: 'local-results', deliveryId: input.deliveryId, attempt: input.attempt };
    },
    async cancel(input: NotificationChannelCancelInput): Promise<boolean> {
      void input;
      return true;
    },
  });
}

export interface NotificationDeliveryService {
  runOnce(input: unknown): Promise<NotificationDeliveryWorkResult>;
}

export function createNotificationDeliveryService(options: NotificationDeliveryServiceOptions): NotificationDeliveryService {
  const policy = validatePolicy(options.policy ?? {});
  const channels = options.channels ?? [createLocalResultsChannel()];
  const channelById = new Map(channels.map(channel => [channel.channelId, channel]));
  if (channelById.size !== channels.length || !channelById.has('local-results')) throw new TypeError('通知渠道装配重复或缺少 local-results');

  async function process(delivery: NotificationDeliveryRecord, channel: NotificationChannel): Promise<NotificationDeliveryAttemptResult> {
    const controller = new AbortController();
    const sendInput: NotificationChannelSendInput = {
      projectId: delivery.projectId,
      deliveryId: delivery.deliveryId, attempt: delivery.attemptCount, summary: delivery.summary, signal: controller.signal,
    };
    let sent: Completed<Readonly<Record<string, unknown>>> | TimedOut;
    try {
      sent = await withinTimeout(() => channel.send(sendInput), policy.sendTimeoutMs, () => controller.abort());
    } catch {
      try {
        const updated = options.store.recordDeliveryResult({ deliveryId: delivery.deliveryId, claimGeneration: delivery.claimGeneration, attempt: delivery.attemptCount, outcome: 'failed', failureReason: 'channel_failed' });
        return { deliveryId: updated.deliveryId, attempt: delivery.attemptCount, status: updated.status === 'exhausted' ? 'exhausted' : 'retry_scheduled', outcome: 'failed', failureReason: 'channel_failed' };
      } catch {
        const confirmed = options.store.readDeliveryResult({ deliveryId: delivery.deliveryId, attempt: delivery.attemptCount });
        if (confirmed?.outcome === 'failed') return { deliveryId: delivery.deliveryId, attempt: delivery.attemptCount, status: confirmed.attempt >= 4 ? 'exhausted' : 'retry_scheduled', outcome: 'failed', failureReason: 'channel_failed' };
        return failedResult(delivery, 'receipt_persistence_failed', 'receipt_persistence_failed');
      }
    }

    if (sent.timedOut) {
      const cancelController = new AbortController();
      const cancelled = channel.cancel === undefined
        ? { timedOut: false as const, value: false }
        : await withinTimeout(() => channel.cancel!({ deliveryId: delivery.deliveryId, attempt: delivery.attemptCount, signal: cancelController.signal }), policy.cancellationTimeoutMs, () => cancelController.abort());
      if (cancelled.timedOut || !cancelled.value) return failedResult(delivery, 'timeout', 'send_timeout_stop_unconfirmed');
      try {
        const updated = options.store.recordDeliveryResult({ deliveryId: delivery.deliveryId, claimGeneration: delivery.claimGeneration, attempt: delivery.attemptCount, outcome: 'failed', failureReason: 'send_timeout' });
        return { deliveryId: updated.deliveryId, attempt: delivery.attemptCount, status: updated.status === 'delivered' ? 'delivered' : updated.status === 'exhausted' ? 'exhausted' : 'retry_scheduled', outcome: 'timeout', failureReason: 'send_timeout' };
      } catch {
        const confirmed = options.store.readDeliveryResult({ deliveryId: delivery.deliveryId, attempt: delivery.attemptCount });
        if (confirmed !== null) return { deliveryId: delivery.deliveryId, attempt: delivery.attemptCount, status: 'retry_scheduled', outcome: 'timeout', failureReason: 'send_timeout' };
        return failedResult(delivery, 'receipt_persistence_failed', 'receipt_persistence_failed');
      }
    }

    try {
      const updated = options.store.recordDeliveryResult({ deliveryId: delivery.deliveryId, claimGeneration: delivery.claimGeneration, attempt: delivery.attemptCount, outcome: 'succeeded', receipt: sent.value });
      return { deliveryId: updated.deliveryId, attempt: delivery.attemptCount, status: updated.status === 'delivered' ? 'delivered' : 'in_flight', outcome: 'succeeded', failureReason: null };
    } catch {
      const confirmed = options.store.readDeliveryResult({ deliveryId: delivery.deliveryId, attempt: delivery.attemptCount });
      if (confirmed?.outcome === 'succeeded') return { deliveryId: delivery.deliveryId, attempt: delivery.attemptCount, status: 'delivered', outcome: 'succeeded', failureReason: null };
      return failedResult(delivery, 'receipt_persistence_failed', 'receipt_persistence_failed');
    }
  }

  async function runOnce(input: unknown): Promise<NotificationDeliveryWorkResult> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('通知工作请求必须是对象');
    const raw = input as Record<string, unknown>;
    for (const key of Object.keys(raw)) if (!['owner', 'channelId', 'limit'].includes(key)) throw new TypeError('通知工作请求包含未知字段');
    const owner = raw.owner;
    if (typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner)) throw new TypeError('通知工作 owner 非法');
    const channelId = raw.channelId === undefined ? 'local-results' : raw.channelId;
    if (channelId !== 'local-results') throw new TypeError('不支持的通知渠道');
    const limit = raw.limit === undefined ? policy.batchSize : raw.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > policy.batchSize) throw new RangeError('通知工作批大小越界');
    const channel = channelById.get(channelId);
    if (channel === undefined) throw new TypeError('通知渠道未装配');
    const claimed = options.store.claimDueDeliveries({ channelId, owner, limit });
    const results: NotificationDeliveryAttemptResult[] = [];
    for (let offset = 0; offset < claimed.deliveries.length; offset += policy.maxConcurrent) {
      const group = claimed.deliveries.slice(offset, offset + policy.maxConcurrent);
      results.push(...await Promise.all(group.map(delivery => process(delivery, channel))));
    }
    return { owner, claimedCount: claimed.deliveries.length, results };
  }

  return Object.freeze({ runOnce });
}
