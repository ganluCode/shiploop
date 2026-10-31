/**
 * P07-4 / F-004 独立通知的版本化端口契约（ports 契约层）。
 *
 * 协议依据：p07-result-notifications PRD FR-2、设计 03 §2/§5/§6、07 §5：
 * - 任务终态由 Core 权威事务写入 state_events；通知扫描事件并幂等生成 delivery，
 *   崩溃不要求重跑 Task；通知失败不改变业务结果（本端口只定义持久模型与写入校验，
 *   事件投影在 F-006、本地渠道认领与重试在 F-007、Host 生命周期接线在 F-008）；
 * - (event_id, channel_id) 组合唯一（设计 03 §2 notification_deliveries）；
 * - 策略有限：次数、退避延迟、摘要/回执大小全部有界（07 §5“限制次数、指数退避及频率”）。
 *
 * 与既有类型区分（显式边界）：
 * - Attempt 生命周期通知（ports/attempt-lifecycle.ts 的 AttemptNotification 与
 *   attempt_notifications 表）：Runtime→Core 的受信生命周期回执，不是用户可见的
 *   结果通知渠道；本端口消费 state_events 而不是 Runtime 上行通知；
 * - Git 发布交付（ports/delivery-policy.ts 与 phase_delivery_* 表）：Feature/Phase
 *   的代码交付决策，不是通知投递；本端口的 delivery 指通知投递记录。
 *
 * 纯度不变量：只做结构校验、冻结词汇与确定性派生（node:crypto 仅用于摘要）；
 * 不导入 HTTP/SSE/ORM/Pi SDK/适配器，不读时钟/文件系统/网络。
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isUuidV4 } from './commands.js';
import { StorageError } from './errors.js';
import type { PublicStateEvent } from './events.js';
import {
  TASK_TERMINAL_EVENT_TYPE,
  TASK_ACTION_REQUIRED_EVENT_TYPE,
  EXECUTION_RUN_TERMINAL_EVENT_TYPE,
  FEATURE_FINALIZED_EVENT_TYPE,
  FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE,
} from './execution-store.js';
import {
  isPlainObject,
  requirePlainObject,
  rejectUnknownKeys,
  validateNonNegativeInteger,
  type ValidationContext,
  validationError,
} from './validation.js';

/** 独立通知契约版本（记录/端口形状演化时递增；未知版本明确拒绝）。 */
export const NOTIFICATION_DELIVERY_SCHEMA_VERSION = 1 as const;

/**
 * 内置固定本地渠道（冻结词汇；PRD：外部 Webhook/系统通知本期不要求）。
 * 不建可编辑外部渠道表或通用插件配置；新渠道经端口版本化扩展。
 */
export const NOTIFICATION_CHANNEL_IDS = ['local-results'] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNEL_IDS)[number];

/** 投递策略版本（与摘要域绑定；写入前核验，未知版本拒绝）。 */
export const NOTIFICATION_DELIVERY_POLICY_VERSION = 1 as const;
/** 策略摘要领域前缀（与 delivery-policy.ts 的冻结摘要域同一方式）。 */
export const NOTIFICATION_DELIVERY_POLICY_DIGEST_DOMAIN = 'shiploop:notification-delivery-policy:v1';

/** 次数硬上限（DDL 与端口一致；任何策略的 maxAttempts 不得超过该值）。 */
export const NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT = 16 as const;
/** 单次退避延迟下界（毫秒）：短于该值的“立即重试”不受支持。 */
export const NOTIFICATION_DELIVERY_MIN_RETRY_DELAY_MS = 1_000 as const;
/** 单次退避延迟硬上限（毫秒）：24 小时。 */
export const NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS = 86_400_000 as const;
/** 脱敏摘要序列化字节上限。 */
export const NOTIFICATION_SUMMARY_MAX_BYTES = 4_096 as const;
/** 摘要内单个字符串值长度上限（脱敏底线：不接受长自由文本冒充摘要）。 */
export const NOTIFICATION_SUMMARY_VALUE_MAX_LENGTH = 256 as const;
/** 回执序列化字节上限（与 attempt_notifications 回执同界）。 */
export const NOTIFICATION_RECEIPT_MAX_BYTES = 8_192 as const;
/** 失败原因长度上限。 */
export const NOTIFICATION_FAILURE_REASON_MAX_LENGTH = 256 as const;

/** 投递状态词汇：等待首投、已认领投递中、送达（回执已存）、失败待重试、次数耗尽停投。 */
export const NOTIFICATION_DELIVERY_STATUSES = [
  'pending', 'in_flight', 'delivered', 'retry_scheduled', 'exhausted',
] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/** 单次投递结果词汇（本地结果记录）。 */
export const NOTIFICATION_DELIVERY_OUTCOMES = ['succeeded', 'failed'] as const;
export type NotificationDeliveryOutcome = (typeof NOTIFICATION_DELIVERY_OUTCOMES)[number];

/** 有限投递策略（全部字段有界；摘要按冻结域计算，可从记录核验）。 */
export interface NotificationDeliveryPolicy {
  /** 最大尝试次数（含首次；1..NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT）。 */
  readonly maxAttempts: number;
  /** 首次失败后的基础退避毫秒（≥1_000）。 */
  readonly baseDelayMs: number;
  /** 指数因子（≥2；每多失败一次乘一次，直至 maxDelayMs 封顶）。 */
  readonly delayFactor: number;
  /** 单次退避上限毫秒（≥baseDelayMs 且 ≤24 小时）。 */
  readonly maxDelayMs: number;
}

/** 产品默认策略（冻结常量；写入路径不接受调用方策略覆盖）。 */
export const DEFAULT_NOTIFICATION_DELIVERY_POLICY: Readonly<NotificationDeliveryPolicy> = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 60_000,
  delayFactor: 8,
  maxDelayMs: 3_600_000,
});

/** 校验策略对象：全部字段在界内，未知键拒绝（返回原值的窄化副本）。 */
export function validateNotificationDeliveryPolicy(
  value: unknown,
  context: ValidationContext,
  field: string,
): NotificationDeliveryPolicy {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, ['maxAttempts', 'baseDelayMs', 'delayFactor', 'maxDelayMs'], context, `${field}.`);
  const maxAttempts = raw.maxAttempts;
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT) {
    throw validationError(context, field, 'maxAttempts 必须是 1..次数硬上限 的整数', maxAttempts);
  }
  const baseDelayMs = raw.baseDelayMs;
  if (typeof baseDelayMs !== 'number' || !Number.isInteger(baseDelayMs) || baseDelayMs < NOTIFICATION_DELIVERY_MIN_RETRY_DELAY_MS || baseDelayMs > NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS) {
    throw validationError(context, field, 'baseDelayMs 必须在退避界内', baseDelayMs);
  }
  const delayFactor = raw.delayFactor;
  if (typeof delayFactor !== 'number' || !Number.isInteger(delayFactor) || delayFactor < 2 || delayFactor > 16) {
    throw validationError(context, field, 'delayFactor 必须是 2..16 的整数', delayFactor);
  }
  const maxDelayMs = raw.maxDelayMs;
  if (typeof maxDelayMs !== 'number' || !Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS) {
    throw validationError(context, field, 'maxDelayMs 必须不小于 baseDelayMs 且在退避界内', maxDelayMs);
  }
  return { maxAttempts, baseDelayMs, delayFactor, maxDelayMs };
}

/** 策略摘要：冻结域前缀 + 字段定序（同一策略重算一致；字段变化即不同）。 */
export function computeNotificationPolicyDigest(policy: NotificationDeliveryPolicy): string {
  return createHash('sha256')
    .update(
      `${NOTIFICATION_DELIVERY_POLICY_DIGEST_DOMAIN}:${policy.maxAttempts}:${policy.baseDelayMs}:${policy.delayFactor}:${policy.maxDelayMs}`,
      'utf8',
    )
    .digest('hex');
}

/** 有界指数退避：第 failedAttempts 次失败后的下次延迟（迭代相乘并在安全整数内封顶）。 */
export function computeNotificationRetryDelayMs(policy: NotificationDeliveryPolicy, failedAttempts: number): number {
  let delay = policy.baseDelayMs;
  for (let index = 2; index <= failedAttempts; index += 1) {
    delay = Math.min(delay * policy.delayFactor, policy.maxDelayMs);
  }
  return Math.min(delay, policy.maxDelayMs);
}

/** 冻结的写入口操作名（存储层结构化错误归属）。 */
export const NOTIFICATION_DELIVERY_CREATE_OPERATION = 'NotificationDelivery.create';
export const NOTIFICATION_DELIVERY_RESULT_OPERATION = 'NotificationDelivery.recordResult';
export const NOTIFICATION_DELIVERY_SCAN_OPERATION = 'NotificationDelivery.advanceScan';
export const NOTIFICATION_DELIVERY_READ_OPERATION = 'NotificationDelivery.read';

/** 校验内置渠道 ID：未知渠道在写入前拒绝（不猜测降级）。 */
export function validateNotificationChannelId(
  value: unknown,
  context: ValidationContext,
  field: string,
): NotificationChannelId {
  if (typeof value !== 'string' || !(NOTIFICATION_CHANNEL_IDS as readonly string[]).includes(value)) {
    throw validationError(context, field, 'unsupported_channel', value);
  }
  return value as NotificationChannelId;
}

/** 递归核验摘要对象：JSON 可序列化、深度有界、单字符串有界、总序列化字节有界。 */
export function validateNotificationSummary(
  value: unknown,
  context: ValidationContext,
  field: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    throw validationError(context, field, 'must_be_object', value);
  }
  const walk = (node: unknown, depth: number): void => {
    if (node === null || typeof node === 'number' || typeof node === 'boolean') {
      if (typeof node === 'number' && !Number.isFinite(node)) {
        throw validationError(context, field, 'summary_value_not_json_safe', node);
      }
      return;
    }
    if (typeof node === 'string') {
      if (node.length > NOTIFICATION_SUMMARY_VALUE_MAX_LENGTH) {
        throw validationError(context, field, 'summary_value_too_long', node.length);
      }
      return;
    }
    if (Array.isArray(node)) {
      if (depth <= 0) throw validationError(context, field, 'summary_depth_exceeded');
      for (const item of node) walk(item, depth - 1);
      return;
    }
    if (isPlainObject(node)) {
      if (depth <= 0) throw validationError(context, field, 'summary_depth_exceeded');
      for (const child of Object.values(node)) walk(child, depth - 1);
      return;
    }
    throw validationError(context, field, 'summary_value_not_json_safe', node);
  };
  for (const child of Object.values(value)) walk(child, 4);
  if (Buffer.byteLength(canonicalNotificationJson(value), 'utf8') > NOTIFICATION_SUMMARY_MAX_BYTES) {
    throw validationError(context, field, 'summary_too_large');
  }
  return value;
}

/** 回执对象校验：对象、深度有界、总序列化字节有界。 */
export function validateNotificationReceipt(
  value: unknown,
  context: ValidationContext,
  field: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    throw validationError(context, field, 'must_be_object', value);
  }
  if (Buffer.byteLength(canonicalNotificationJson(value), 'utf8') > NOTIFICATION_RECEIPT_MAX_BYTES) {
    throw validationError(context, field, 'receipt_too_large');
  }
  return value;
}

/** 规范化序列化（键定序；幂等比较与持久化共用同一形态）。 */
export function canonicalNotificationJson(value: Readonly<Record<string, unknown>>): string {
  const entries = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of entries) {
    const child = value[key];
    parts.push(`${JSON.stringify(key)}:${child === undefined ? 'null' : JSON.stringify(child)}`);
  }
  return `{${parts.join(',')}}`;
}

/** 通知 delivery 公开记录（从持久行单向映射；携带契约版本）。 */
export interface NotificationDeliveryRecord {
  readonly schemaVersion: typeof NOTIFICATION_DELIVERY_SCHEMA_VERSION;
  readonly deliveryId: string;
  readonly projectId: string;
  readonly eventId: string;
  readonly channelId: NotificationChannelId;
  readonly eventSequence: number;
  readonly eventType: string;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly status: NotificationDeliveryStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly claimGeneration: number;
  readonly receipt: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

/** createDelivery 结果：created=false 表示幂等重放（返回既有行，零变更）。 */
export interface NotificationDeliveryWriteResult {
  readonly created: boolean;
  readonly delivery: NotificationDeliveryRecord;
}

/** 扫描水位记录（每渠道一行；lastScannedSequence 单调不回退）。 */
export interface NotificationScanStateRecord {
  readonly schemaVersion: typeof NOTIFICATION_DELIVERY_SCHEMA_VERSION;
  readonly channelId: NotificationChannelId;
  readonly lastScannedSequence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

/** 本地结果记录（每次尝试一条；(deliveryId, attempt) 唯一）。 */
export interface NotificationDeliveryResultRecord {
  readonly schemaVersion: typeof NOTIFICATION_DELIVERY_SCHEMA_VERSION;
  readonly resultId: string;
  readonly projectId: string;
  readonly deliveryId: string;
  readonly attempt: number;
  readonly outcome: NotificationDeliveryOutcome;
  readonly receipt: Readonly<Record<string, unknown>> | null;
  readonly failureReason: string | null;
  readonly occurredAt: number;
}

/** createDelivery 输入（项目归属由源事件在写事务内权威派生，不由调用方声明）。 */
export interface NotificationDeliveryCreateInput {
  readonly eventId: string;
  readonly channelId: NotificationChannelId;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly policyVersion?: number;
}

/** 校验 createDelivery 输入（unknown → 形状；持久校验在适配器写事务内）。 */
export function validateNotificationDeliveryCreateInput(
  value: unknown,
  operation: string = NOTIFICATION_DELIVERY_CREATE_OPERATION,
): NotificationDeliveryCreateInput {
  const context: ValidationContext = { operation };
  const raw = requirePlainObject(value, context, 'request');
  rejectUnknownKeys(raw, ['eventId', 'channelId', 'summary', 'policyVersion'], context, 'request.');
  if (typeof raw.eventId !== 'string' || !isUuidV4(raw.eventId)) {
    throw validationError(context, 'eventId', 'invalid_event_id', raw.eventId);
  }
  const channelId = validateNotificationChannelId(raw.channelId, context, 'channelId');
  if (raw.policyVersion !== undefined && raw.policyVersion !== NOTIFICATION_DELIVERY_POLICY_VERSION) {
    throw validationError(context, 'policyVersion', 'unsupported_policy_version', raw.policyVersion);
  }
  const summary = validateNotificationSummary(raw.summary, context, 'summary');
  return { eventId: raw.eventId, channelId, summary, ...(raw.policyVersion === undefined ? {} : { policyVersion: raw.policyVersion }) };
}

/** recordDeliveryResult 输入（占用代次 fencing + 顺序尝试号 + 结果形状）。 */
export interface NotificationDeliveryResultInput {
  readonly deliveryId: string;
  readonly claimGeneration: number;
  readonly attempt: number;
  readonly outcome: NotificationDeliveryOutcome;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly failureReason?: string;
  readonly nextAttemptAt?: number;
}

/** 校验结果输入：未知结果、超界次数、结果形状与大小在写入前拒绝。 */
export function validateNotificationDeliveryResultInput(
  value: unknown,
  operation: string = NOTIFICATION_DELIVERY_RESULT_OPERATION,
): NotificationDeliveryResultInput {
  const context: ValidationContext = { operation };
  const raw = requirePlainObject(value, context, 'request');
  rejectUnknownKeys(raw, ['deliveryId', 'claimGeneration', 'attempt', 'outcome', 'receipt', 'failureReason', 'nextAttemptAt'], context, 'request.');
  if (typeof raw.deliveryId !== 'string' || raw.deliveryId.length === 0 || raw.deliveryId.length > 128) {
    throw validationError(context, 'deliveryId', 'invalid_delivery_id', raw.deliveryId);
  }
  const claimGeneration = validateNonNegativeInteger(raw.claimGeneration, context, 'claimGeneration');
  if (typeof raw.attempt !== 'number' || !Number.isInteger(raw.attempt) || raw.attempt < 1 || raw.attempt > NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT) {
    throw validationError(context, 'attempt', 'attempt_out_of_range', raw.attempt);
  }
  const attempt = raw.attempt;
  if (typeof raw.outcome !== 'string' || !(NOTIFICATION_DELIVERY_OUTCOMES as readonly string[]).includes(raw.outcome)) {
    throw validationError(context, 'outcome', 'unsupported_outcome', raw.outcome);
  }
  const outcome = raw.outcome as NotificationDeliveryOutcome;
  if (raw.nextAttemptAt !== undefined && (typeof raw.nextAttemptAt !== 'number' || !Number.isSafeInteger(raw.nextAttemptAt) || raw.nextAttemptAt < 1)) {
    throw validationError(context, 'nextAttemptAt', 'sequence_out_of_range', raw.nextAttemptAt);
  }
  if (outcome === 'succeeded') {
    if (raw.receipt === undefined) throw validationError(context, 'receipt', 'receipt_required');
    if (raw.failureReason !== undefined) throw validationError(context, 'failureReason', 'failure_reason_not_allowed');
    if (raw.nextAttemptAt !== undefined) throw validationError(context, 'nextAttemptAt', 'next_attempt_not_allowed');
    validateNotificationReceipt(raw.receipt, context, 'receipt');
    return {
      deliveryId: raw.deliveryId, claimGeneration, attempt, outcome,
      receipt: raw.receipt as Readonly<Record<string, unknown>>,
    };
  }
  if (raw.receipt !== undefined) throw validationError(context, 'receipt', 'receipt_not_allowed');
  if (raw.failureReason === undefined) throw validationError(context, 'failureReason', 'failure_reason_required');
  if (typeof raw.failureReason !== 'string' || raw.failureReason.length === 0 || raw.failureReason.length > NOTIFICATION_FAILURE_REASON_MAX_LENGTH) {
    throw validationError(context, 'failureReason', 'failure_reason_too_long', raw.failureReason);
  }
  return {
    deliveryId: raw.deliveryId, claimGeneration, attempt, outcome, failureReason: raw.failureReason,
    ...(raw.nextAttemptAt === undefined ? {} : { nextAttemptAt: raw.nextAttemptAt }),
  };
}

/** 扫描水位推进输入。 */
export interface NotificationScanAdvanceInput {
  readonly channelId: NotificationChannelId;
  readonly lastScannedSequence: number;
}

/** 校验水位推进输入：未知渠道与非安全整数/负数序号拒绝。 */
export function validateNotificationScanAdvanceInput(
  value: unknown,
  operation: string = NOTIFICATION_DELIVERY_SCAN_OPERATION,
): NotificationScanAdvanceInput {
  const context: ValidationContext = { operation };
  const raw = requirePlainObject(value, context, 'request');
  rejectUnknownKeys(raw, ['channelId', 'lastScannedSequence'], context, 'request.');
  const channelId = validateNotificationChannelId(raw.channelId, context, 'channelId');
  if (typeof raw.lastScannedSequence !== 'number' || !Number.isSafeInteger(raw.lastScannedSequence) || raw.lastScannedSequence < 0) {
    throw validationError(context, 'lastScannedSequence', 'sequence_out_of_range', raw.lastScannedSequence);
  }
  return { channelId, lastScannedSequence: raw.lastScannedSequence };
}

/* ------------------------------------------------------------------ *
 * P07-4 / F-006：持久 state_events → 脱敏 delivery 的有界幂等投影契约
 * （PRD FR-2、设计 03 §5、07 §5；事件事实源是持久审计表，不是 SSE/内存回调）
 * ------------------------------------------------------------------ */

/** 投影操作名（结构化错误归属）。 */
export const NOTIFICATION_PROJECTION_OPERATION = 'NotificationDelivery.projectBatch';
/** 单批扫描事件数默认值。 */
export const NOTIFICATION_PROJECTION_BATCH_DEFAULT = 100 as const;
/** 单批扫描事件数硬上限（与 §13 事件补读分页上限同界）。 */
export const NOTIFICATION_PROJECTION_BATCH_MAX = 500 as const;
/** 投影摘要契约版本（未知版本的派生结果拒绝持久化）。 */
export const NOTIFICATION_SUMMARY_SCHEMA_VERSION = 1 as const;

/**
 * 默认订阅注册表（冻结词汇；设计 07 §5“默认订阅 Feature 完成、Run 结束、
 * 失败和需人处理”+ F-005 定案补 Task 终态）：
 * - task.terminal：Task 终态（含失败/取消）；
 * - task.action_required：需人处理（人工审批阻塞）；
 * - execution.run.ended：Run 结束（含失败）；
 * - feature.finalized / feature.finalization_blocked：Feature 最终交付完成/受阻。
 * execution.batch.ended 等其余白名单事件是非订阅事件：扫描位置照常推进，
 * 不产生 delivery；新订阅类型经端口版本化扩展，不猜下游渠道。
 */
export const NOTIFICATION_SUBSCRIPTION_EVENT_TYPES = [
  TASK_TERMINAL_EVENT_TYPE,
  TASK_ACTION_REQUIRED_EVENT_TYPE,
  EXECUTION_RUN_TERMINAL_EVENT_TYPE,
  FEATURE_FINALIZED_EVENT_TYPE,
  FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE,
] as const;
export type NotificationSubscriptionEventType = (typeof NOTIFICATION_SUBSCRIPTION_EVENT_TYPES)[number];

/** 是否默认订阅事件类型（冻结词汇判断，不猜测降级）。 */
export function isNotificationSubscriptionEventType(value: string): value is NotificationSubscriptionEventType {
  return (NOTIFICATION_SUBSCRIPTION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * 从已验证公开事件派生脱敏摘要（纯函数、确定性、无 I/O）：
 * - 只取冻结 kind、固定身份（聚合 ID）、结果类别（受控枚举）、安全引用
 *   （稳定 ID/受控字符串），不复制 payload 原文、错误正文、路径或凭据；
 * - 输入必须已经过 mapStateEvent 白名单/形状校验（未知类型不进入本函数）；
 * - 非订阅事件返回 null（扫描位置照常推进，不产生 delivery）；
 * - 历史 feature.finalized/blocked 旧短形态（{finalized:true}/{blocked:true}）
 *   只携带固定身份与 kind，不伪造结果轴。
 */
export function deriveNotificationSummary(
  event: PublicStateEvent,
): Readonly<Record<string, unknown>> | null {
  const aggregateId = event.aggregate.id;
  switch (event.type) {
    case TASK_TERMINAL_EVENT_TYPE: {
      const payload = event.payload as { status: string; resultCategory: string; attemptId: string; runId: string; resultRef: string | null };
      return {
        schemaVersion: NOTIFICATION_SUMMARY_SCHEMA_VERSION,
        kind: 'task_terminal',
        taskId: aggregateId,
        status: payload.status,
        resultCategory: payload.resultCategory,
        attemptId: payload.attemptId,
        runId: payload.runId,
        resultRef: payload.resultRef,
      };
    }
    case TASK_ACTION_REQUIRED_EVENT_TYPE: {
      const payload = event.payload as { action: string; itemId: string; reason: string };
      return {
        schemaVersion: NOTIFICATION_SUMMARY_SCHEMA_VERSION,
        kind: 'task_action_required',
        taskId: aggregateId,
        action: payload.action,
        itemId: payload.itemId,
        reason: payload.reason,
      };
    }
    case EXECUTION_RUN_TERMINAL_EVENT_TYPE: {
      const payload = event.payload as { status: string; resultCategory: string; resultRef: string | null; batchId: string; featureId: string };
      return {
        schemaVersion: NOTIFICATION_SUMMARY_SCHEMA_VERSION,
        kind: 'run_ended',
        runId: aggregateId,
        status: payload.status,
        resultCategory: payload.resultCategory,
        resultRef: payload.resultRef,
        batchId: payload.batchId,
        featureId: payload.featureId,
      };
    }
    case FEATURE_FINALIZED_EVENT_TYPE:
    case FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE: {
      const blocked = event.type === FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE;
      if (!blocked && (event.payload as { finalized?: true }).finalized === true) {
        return { schemaVersion: NOTIFICATION_SUMMARY_SCHEMA_VERSION, kind: 'feature_finalized', featureId: aggregateId };
      }
      if (blocked && (event.payload as { blocked?: true }).blocked === true) {
        return { schemaVersion: NOTIFICATION_SUMMARY_SCHEMA_VERSION, kind: 'feature_finalization_blocked', featureId: aggregateId };
      }
      const payload = event.payload as { outcome: string; deliveryStatus: string; reasonCode: string; runId: string; batchId: string; operationId: string | null };
      return {
        schemaVersion: NOTIFICATION_SUMMARY_SCHEMA_VERSION,
        kind: blocked ? 'feature_finalization_blocked' : 'feature_finalized',
        featureId: aggregateId,
        outcome: payload.outcome,
        deliveryStatus: payload.deliveryStatus,
        reasonCode: payload.reasonCode,
        runId: payload.runId,
        batchId: payload.batchId,
        operationId: payload.operationId,
      };
    }
    default:
      return null;
  }
}

/** 单批投影请求：内置渠道 + 可选批大小（缺省默认值，上限硬约束）。 */
export interface NotificationProjectionBatchRequest {
  readonly channelId: NotificationChannelId;
  readonly batchSize?: number;
}

/** 校验单批投影请求：未知渠道/未知键拒绝，批大小缺省默认且 1..上限。 */
export function validateNotificationProjectionBatchRequest(
  value: unknown,
  operation: string = NOTIFICATION_PROJECTION_OPERATION,
): { channelId: NotificationChannelId; batchSize: number } {
  const context: ValidationContext = { operation };
  const raw = requirePlainObject(value, context, 'request');
  rejectUnknownKeys(raw, ['channelId', 'batchSize'], context, 'request.');
  const channelId = validateNotificationChannelId(raw.channelId, context, 'channelId');
  if (raw.batchSize !== undefined && (typeof raw.batchSize !== 'number' || !Number.isInteger(raw.batchSize)
    || raw.batchSize < 1 || raw.batchSize > NOTIFICATION_PROJECTION_BATCH_MAX)) {
    throw validationError(context, 'batchSize', 'batch_size_out_of_range', raw.batchSize);
  }
  return { channelId, batchSize: raw.batchSize ?? NOTIFICATION_PROJECTION_BATCH_DEFAULT };
}

/** 单批投影结果（全部字段有界；createdDeliveries 只列本批新建行）。 */
export interface NotificationProjectionBatchResult {
  readonly channelId: NotificationChannelId;
  /** 本批推进后的持久消费水位（空批为原水位，不变）。 */
  readonly lastScannedSequence: number;
  /** 本批实际扫描的持久事件行数（含非订阅事件）。 */
  readonly scannedCount: number;
  /** 本批新建的 delivery（幂等重放/已存在行不重复列出）。 */
  readonly createdDeliveries: readonly NotificationDeliveryRecord[];
  /** 本批后是否可能仍有未扫描事件（扫描满批即保守为 true）。 */
  readonly moreAvailable: boolean;
}

/**
 * 独立通知持久写模型窄端口（F-004 交付持久结构与原子校验；F-006 扩展事件
 * 投影，认领/续投由后续 Task 在此端口上扩展）。全部写入在单事务内完成原子
 * 校验与持久化，拒绝路径零部分写入。
 */
export interface NotificationDeliveryStore {
  /** 幂等创建：同 (eventId, channelId) 同摘要重放返回既有行；摘要变化冲突拒绝。 */
  createDelivery(input: unknown): NotificationDeliveryWriteResult;
  /** 记录一次投递结果：fencing/顺序/终态/延迟界内校验后更新 delivery 并追加本地结果。 */
  recordDeliveryResult(input: unknown): NotificationDeliveryRecord;
  /** 推进渠道扫描水位：单调、不超前事件水位；同值幂等零变更。 */
  advanceScanState(input: unknown): NotificationScanStateRecord;
  /** 点读 delivery（缺失 not_found；损坏行 corrupt）。 */
  readDelivery(input: unknown): NotificationDeliveryRecord;
  /** 点读扫描水位（未建立返回 null，调用方按 0 处理）。 */
  readScanState(input: unknown): NotificationScanStateRecord | null;
  /**
   * F-006：单短事务内有界扫描一批持久事件，为订阅事件幂等创建 delivery 并
   * 原子推进消费水位；损坏事件/水位断档显式失败（corrupt，带 sequence 定位，
   * 不回显原文），不静默越过；空批次零写入。
   */
  projectNotificationBatch(input: unknown): NotificationProjectionBatchResult;
}

/** 行列映射时未知状态/结果/渠道一律持久损坏（写入路径只产生冻结词汇）。 */
export function notificationDeliveryCorrupt(operation: string, reason: string): StorageError {
  return new StorageError('corrupt', operation, `通知持久行超出契约形态：${reason}`, { details: { reason } });
}
