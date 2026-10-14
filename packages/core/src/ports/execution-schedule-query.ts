/**
 * P03-4 / F-007 Run 调度原因、Task 派生就绪视图与 Attempt/占用审计只读查询
 * 契约（ports 纯契约层）。
 *
 * 设计依据：core-design/04 §3/§6（SQLite 是调度真相、原因可查询、占用审计）
 * 与 docs/p03-4-task-dag-readiness-contract.md（同一就绪判定规则
 * evaluateTaskDag；ready/blocked 是持久状态的派生视图，绝不落库为第二套
 * 可写 Task 状态）、docs/p03-4-attempt-lifecycle-contract.md（有界脱敏诊断
 * 只保留同项目 Attempt 链接、时间、固定原因与摘要）。
 *
 * 不变量：
 * - 全部内容取自持久 SQLite 的一致读视图（ExecutionScheduleQueryReadStore，
 *   适配器以 BEGIN DEFERRED 读事务实现）；查询面零写入、零事件、零唤醒、
 *   零续租——不创建 Attempt、不扣预算、不启动任何工作；
 * - 调度原因由同一 evaluateTaskDag 纯规则从一致读视图派生（应用层复用
 *   application/task-dag）；本模块只声明形状与分页/游标纪律，不重复实现
 *   判定逻辑；损坏持久视图降级为 invalid_graph（diagnostic 明确），Run
 *   本身仍可读，绝不伪造 ready；
 * - 公开形状只暴露身份/状态/计数/时间等结构化事实：绝不携带 input/config/
 *   scope 快照正文、秘密配置、任意文件内容或开发机绝对路径（占用
 *   resourceKey 是规范化哈希键，不是路径）；
 * - 未启动/无耗时/无退出信息/无用量一律 null（明确未知），不以 0 冒充；
 *   executionStage 原样展示（verifying 不是验收通过）；
 * - Attempt 与诊断列表复用计划分页同一规范：limit 默认 50 / 上限 200、
 *   plcur_v1_ 受控游标（绑定数据根 + 项目 + 父级实体，跨项目/跨父级/跨根
 *   重放一律 invalid_cursor）；排序键与行身份组成复合键
 *   （encodeExecutionListKey），键集分页稳定；
 * - 跨项目/不存在目标统一 undefined（应用层折叠为 not_found，不泄漏
 *   存在性）；visibility 非法形状为可信装配编程错误（TypeError）。
 */
import { PublicError, WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import type {
  AttemptExecutionStage,
  AttemptRecord,
  AttemptStatus,
  AttemptUsageSummary,
  WorkspaceLeaseRecord,
} from './attempt-store.js';
import type { RunRecord } from './execution-store.js';
import type { TaskDagReason, TaskDagView } from './task-dag.js';
import type { TaskStatus } from './plan-store.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requirePlainObject,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 查询操作身份（PublicError.operation 与后续 Host 路由共用；Host 接线属 F-008）
 * ------------------------------------------------------------------ */

export const EXECUTION_RUN_SCHEDULE_OPERATION = 'execution.run.schedule' as const;
export const EXECUTION_ATTEMPTS_LIST_OPERATION = 'execution.attempts.list' as const;
export const EXECUTION_ATTEMPT_DIAGNOSTICS_OPERATION = 'execution.attempt.diagnostics' as const;

export const EXECUTION_SCHEDULE_QUERY_OPERATIONS = [
  EXECUTION_RUN_SCHEDULE_OPERATION,
  EXECUTION_ATTEMPTS_LIST_OPERATION,
  EXECUTION_ATTEMPT_DIAGNOSTICS_OPERATION,
] as const;

export type ExecutionScheduleQueryOperation = (typeof EXECUTION_SCHEDULE_QUERY_OPERATIONS)[number];

/* ------------------------------------------------------------------ *
 * 迟到/越权通知诊断（与 attempt_notification_diagnostics 表同一冻结词汇）
 * ------------------------------------------------------------------ */

export const ATTEMPT_NOTIFICATION_DIAGNOSTIC_REASONS = [
  'stale_execution_identity',
  'invalid_transition',
  'notification_id_reused',
] as const;
export type AttemptNotificationDiagnosticReason =
  (typeof ATTEMPT_NOTIFICATION_DIAGNOSTIC_REASONS)[number];

/**
 * 持久诊断行（窄读取面）：只含同项目 Attempt 链接、摘要、固定原因与时间；
 * 绝不保留原通知的标识符、消息、输出、路径或凭据。
 */
export interface AttemptNotificationDiagnosticRecord {
  readonly id: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly notificationDigest: string;
  readonly reason: AttemptNotificationDiagnosticReason;
  readonly occurredAtUtcMs: number;
}

const DIAGNOSTIC_CONTEXT: ValidationContext = { operation: 'AttemptDiagnostics.validate' };

/** 持久诊断行严格校验（适配器行映射复核；损坏持久数据为 corrupt_state）。 */
export function validateAttemptNotificationDiagnosticRecord(
  value: unknown,
): AttemptNotificationDiagnosticRecord {
  const raw = requirePlainObject(value, DIAGNOSTIC_CONTEXT, 'diagnostic');
  rejectUnknownKeys(
    raw,
    ['id', 'projectId', 'attemptId', 'notificationDigest', 'reason', 'occurredAtUtcMs'],
    DIAGNOSTIC_CONTEXT,
    'diagnostic',
  );
  const reason = raw.reason;
  if (
    typeof reason !== 'string' ||
    !(ATTEMPT_NOTIFICATION_DIAGNOSTIC_REASONS as readonly string[]).includes(reason)
  ) {
    throw validationError(DIAGNOSTIC_CONTEXT, 'reason', 'invalid_enum');
  }
  if (
    typeof raw.occurredAtUtcMs !== 'number' ||
    !Number.isSafeInteger(raw.occurredAtUtcMs) ||
    raw.occurredAtUtcMs < 0
  ) {
    throw validationError(DIAGNOSTIC_CONTEXT, 'occurredAtUtcMs', 'invalid_safe_integer');
  }
  return {
    id: validateStableId(raw.id, DIAGNOSTIC_CONTEXT, 'id'),
    projectId: validateStableId(raw.projectId, DIAGNOSTIC_CONTEXT, 'projectId'),
    attemptId: validateStableId(raw.attemptId, DIAGNOSTIC_CONTEXT, 'attemptId'),
    notificationDigest: validateSha256Digest(raw.notificationDigest, DIAGNOSTIC_CONTEXT, 'notificationDigest'),
    reason: reason as AttemptNotificationDiagnosticReason,
    occurredAtUtcMs: raw.occurredAtUtcMs,
  };
}

/* ------------------------------------------------------------------ *
 * 复合排序键（Attempt/诊断列表的键集分页游标载荷）
 * ------------------------------------------------------------------ */

const EXECUTION_LIST_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 复合排序键：sort（审计顺序：Attempt number / 诊断 occurredAtUtcMs）+ 行身份。 */
export interface ExecutionListCursorKey {
  readonly sort: number;
  readonly id: string;
}

/** 列表读取请求：排他键集下界（null = 从头）与有界页大小（应用层已校验）。 */
export interface ExecutionListRequest {
  readonly after: ExecutionListCursorKey | null;
  readonly limit: number;
}

/** 列表存储页：nextKey 为用满 limit 时的末条复合键（供应用层编码游标），否则 null。 */
export interface ExecutionRecordPage<T> {
  readonly records: readonly T[];
  readonly nextKey: ExecutionListCursorKey | null;
}

/** 组合复合排序键（服务端内部调用；非法成分为编程错误 TypeError）。 */
export function encodeExecutionListKey(key: ExecutionListCursorKey): string {
  if (
    !isPlainObject(key) ||
    typeof key.sort !== 'number' ||
    !Number.isSafeInteger(key.sort) ||
    key.sort < 0 ||
    typeof key.id !== 'string' ||
    !EXECUTION_LIST_KEY_ID_PATTERN.test(key.id)
  ) {
    throw new TypeError('encodeExecutionListKey: 非法复合排序键（服务端内部调用）');
  }
  return `${key.sort}_${key.id}`;
}

/**
 * 解析游标载荷中的复合排序键（unknown → {sort,id}）。形态非法一律
 * invalid_input(invalid_cursor)，绝不当作从零读取。
 */
export function decodeExecutionListKey(
  value: unknown,
  operation: string,
): ExecutionListCursorKey {
  function invalid(): never {
    throw new PublicError('invalid_input', operation, undefined, {
      details: { field: 'cursor', reason: 'invalid_cursor' },
    });
  }
  if (typeof value !== 'string') {
    invalid();
  }
  const separator = value.indexOf('_');
  if (separator < 1 || separator === value.length - 1) {
    invalid();
  }
  const sortText = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!/^[0-9]+$/.test(sortText) || !EXECUTION_LIST_KEY_ID_PATTERN.test(id)) {
    invalid();
  }
  const sort = Number(sortText);
  if (!Number.isSafeInteger(sort)) {
    invalid();
  }
  return { sort, id };
}

/* ------------------------------------------------------------------ *
 * execution.run.schedule 公开形状
 * ------------------------------------------------------------------ */

/** Run 公开视图：派发身份 + 持久控制原因 + 时间事实（未启动/未结束保持 null）。 */
export interface PublicScheduleRunView {
  readonly id: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly purpose: string;
  readonly workKey: string;
  readonly dispatchOrdinal: number;
  readonly status: RunRecord['status'];
  /** 持久控制原因（如 scheduler_not_assembled / 最终验收交接；无则 null）。 */
  readonly reason: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
}

/** 任务最近 Attempt 摘要（审计定位；executionStage 原样展示，不代表验收）。 */
export interface PublicAttemptSummary {
  readonly id: string;
  readonly number: number;
  readonly status: AttemptStatus;
  readonly executionStage: AttemptExecutionStage;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly errorKind: string | null;
}

/** Task 派生就绪视图：同一就绪判定规则的逐任务结果 + 持久事实 + 最近 Attempt。 */
export interface PublicScheduleTaskView {
  readonly taskId: string;
  readonly status: TaskStatus;
  /** 逐任务 blocked/ready 原因（TaskDagReason 冻结词汇；ready 是可认领候选）。 */
  readonly reason: TaskDagReason;
  readonly dependencyIds: readonly string[];
  readonly executionVersion: number;
  readonly manualBlock: boolean;
  readonly latestAttempt: PublicAttemptSummary | null;
}

/** 占用审计行（held/quarantined；resourceKey 是规范化哈希键，不是路径）。 */
export interface PublicOccupancyRecord {
  readonly id: string;
  /** 占用属主 Attempt 身份（ownerKind 恒为 attempt）。 */
  readonly attemptId: string;
  /** 属主 Attempt 所属 Run（跨 Run 占用如实关联，不隐藏）。 */
  readonly runId: string;
  readonly resourceKind: WorkspaceLeaseRecord['resourceKind'];
  readonly resourceKey: string;
  readonly state: WorkspaceLeaseRecord['state'];
  readonly leaseUntil: string;
  /** 监督进程身份是否已登记（身份正文不进入公开面）。 */
  readonly processIdentity: boolean;
}

/** Run 调度评估摘要（同一 evaluateTaskDag 规则的派生结果；不落库）。 */
export interface RunScheduleEvaluation {
  readonly reason: TaskDagReason;
  readonly diagnostic: string | null;
  /** 稳定候选顺序（拓扑序 + Task ID code-unit 决胜）。 */
  readonly readyTaskIds: readonly string[];
  readonly handoff: 'feature_final_verification' | null;
}

/** execution.run.schedule 结果（一致读视图 + 派生就绪评估的纯序列化投影）。 */
export interface RunScheduleStatusResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'run-schedule';
  readonly run: PublicScheduleRunView;
  readonly schedule: RunScheduleEvaluation;
  /** 稳定顺序（DAG 拓扑序；invalid_graph 时为稳定 id 序或空）。 */
  readonly tasks: readonly PublicScheduleTaskView[];
  /** 项目当前 retained 占用（held/quarantined；释放的占用不留存）。 */
  readonly occupancy: readonly PublicOccupancyRecord[];
}

/* ------------------------------------------------------------------ *
 * execution.attempts.list 公开形状
 * ------------------------------------------------------------------ */

/**
 * Attempt 审计公开记录：关联身份、围栏身份、状态/阶段、已知退出/耗时与用量
 * 原样保留（未知为 null）；绝不携带 inputSnapshot 正文（审计关联使用
 * inputDigest/inputRef 身份）。
 */
export interface PublicAttemptRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly number: number;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly leaseUntil: string;
  readonly status: AttemptStatus;
  readonly executionStage: AttemptExecutionStage;
  readonly inputDigest: string;
  readonly inputRef: string;
  readonly sessionId: string | null;
  readonly invocationId: string | null;
  readonly codeRef: string | null;
  readonly errorKind: string | null;
  readonly diagnosticRef: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly usageSummary: AttemptUsageSummary | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicAttemptRecord(record: AttemptRecord): PublicAttemptRecord {
  const iso = (value: number | null): string | null =>
    value === null ? null : new Date(value).toISOString();
  return {
    id: record.id,
    projectId: record.projectId,
    featureId: record.featureId,
    runId: record.runId,
    taskId: record.taskId,
    number: record.number,
    owner: record.owner,
    hostInstanceId: record.hostInstanceId,
    executionVersion: record.executionVersion,
    leaseUntil: new Date(record.leaseUntilUtcMs).toISOString(),
    status: record.status,
    executionStage: record.executionStage,
    inputDigest: record.inputDigest,
    inputRef: record.inputRef,
    sessionId: record.sessionId,
    invocationId: record.invocationId,
    codeRef: record.codeRef,
    errorKind: record.errorKind,
    diagnosticRef: record.diagnosticRef,
    startedAt: iso(record.startedAtUtcMs),
    endedAt: iso(record.endedAtUtcMs),
    durationMs: record.durationMs,
    exitCode: record.exitCode,
    usageSummary: record.usageSummary === null ? null : { ...record.usageSummary },
    revision: record.revision,
    createdAt: new Date(record.createdAtUtcMs).toISOString(),
    updatedAt: new Date(record.updatedAtUtcMs).toISOString(),
  };
}

/** execution.attempts.list 结果（复用既有有界分页/受控游标规则）。 */
export interface AttemptListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'attempt-list';
  readonly records: readonly PublicAttemptRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

/* ------------------------------------------------------------------ *
 * execution.attempt.diagnostics 公开形状
 * ------------------------------------------------------------------ */

export interface PublicAttemptDiagnosticRecord {
  readonly id: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly notificationDigest: string;
  readonly reason: AttemptNotificationDiagnosticReason;
  readonly occurredAt: string;
}

export function toPublicAttemptDiagnosticRecord(
  record: AttemptNotificationDiagnosticRecord,
): PublicAttemptDiagnosticRecord {
  return {
    id: record.id,
    projectId: record.projectId,
    attemptId: record.attemptId,
    notificationDigest: record.notificationDigest,
    reason: record.reason,
    occurredAt: new Date(record.occurredAtUtcMs).toISOString(),
  };
}

/** execution.attempt.diagnostics 结果（复用既有有界分页/受控游标规则）。 */
export interface AttemptDiagnosticsResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'attempt-diagnostic-list';
  readonly records: readonly PublicAttemptDiagnosticRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

/* ------------------------------------------------------------------ *
 * 一致读视图与窄读取端口（adapters 层实现；应用层授权完成后调用）
 * ------------------------------------------------------------------ */

/** 占用行与属主 Run 的关联（同一读事务内 JOIN 解析；归属绝不信任请求字段）。 */
export interface RunScheduleOccupancyRow {
  readonly lease: WorkspaceLeaseRecord;
  readonly runId: string;
}

/**
 * Run 调度一致读视图：Run 行 + 本 Run 全部 Attempt + 项目 retained 占用
 * （held/quarantined）+ Task DAG 视图在同一 DEFERRED 读事务内取得；
 * 持久视图损坏时 dag 为 null（应用层降级 invalid_graph，Run/占用仍如实可读）。
 */
export interface RunScheduleView {
  readonly run: RunRecord;
  readonly dag: TaskDagView | null;
  /** 本 Run 的全部 Attempt（(taskId, number, id) 稳定序）。 */
  readonly attempts: readonly AttemptRecord[];
  /** 项目 retained 占用（(ownerId, resourceKey) 稳定序）。 */
  readonly occupancy: readonly RunScheduleOccupancyRow[];
}

/**
 * 调度/审计查询窄读取端口：只读（无任何写原语）；跨项目/不存在目标统一
 * undefined（可见性与存在性折叠由应用层统一为 not_found，不泄漏存在性）；
 * 列表沿用计划分页的可见范围谓词与键集分页形态（复合排序键由
 * ExecutionListRequest 承载，应用层已解码校验）。
 */
export interface ExecutionScheduleQueryReadStore {
  readRunScheduleView(projectId: unknown, runId: unknown): RunScheduleView | undefined;
  readAttemptRecord(projectId: unknown, attemptId: unknown): AttemptRecord | undefined;
  listTaskAttemptRecords(
    visibility: unknown,
    projectId: unknown,
    taskId: unknown,
    request: ExecutionListRequest,
  ): ExecutionRecordPage<AttemptRecord>;
  listAttemptDiagnosticRecords(
    visibility: unknown,
    projectId: unknown,
    attemptId: unknown,
    request: ExecutionListRequest,
  ): ExecutionRecordPage<AttemptNotificationDiagnosticRecord>;
}
