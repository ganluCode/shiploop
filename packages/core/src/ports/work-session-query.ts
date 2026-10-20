/**
 * P03-6 / F-011 Work Session、Runtime 结果、停止证据与最小诊断制品的只读
 * 授权查询契约（ports 纯契约层）。
 *
 * 设计依据：core-design/04 §3/§6（SQLite 是调度真相、原因可查询）、
 * docs/p03-6-work-session-contract.md（Session 是最小持久关联与诊断入口，
 * 未知指标保持 null）、docs/p03-4-schedule-query-contract.md（同一分页/
 * 游标/只读纪律）与 docs/p03-3a-runtime-recovery-contract.md（原生引用只是
 * 自描述指针，恢复不等于验收）。
 *
 * 不变量：
 * - 全部内容取自持久 SQLite 的一致读视图（WorkSessionQueryReadStore，适配器
 *   以 BEGIN DEFERRED 读事务实现）与经完整性核验的 ready Artifact 正文
 *   （复用既有 ArtifactVerifier.readVerifiedContent，hash/size 核验）；绝不
 *   以 logger、内存句柄或运行时进程状态作为权威；重开数据库结果一致；
 * - 查询面零写入、零事件、零唤醒、零续租——不创建 Attempt、不扣预算、不
 *   触发取消或执行、不接受任意文件路径（证据读取只按 Session/Attempt 受控
 *   locator 前缀的制品成员资格）；
 * - 公开形状只暴露身份/状态/计数/时间/受控引用等结构化事实：绝不携带
 *   inputSnapshot 正文、秘密配置、绝对路径或物理位置；providerSessionId 与
 *   storage_locator 不进入公开面（原生身份与逻辑定位只是内部诊断细节）；
 * - 未启动/无耗时/无退出信息/无用量/无水位一律 null（明确未知），不以 0
 *   冒充；usage.basis 原样保留——synthetic 用量显式标记，绝不冒充供应商
 *   计费；executionStage 原样展示（verifying 不是验收通过）；
 * - 派生展示分类（deriveWorkSessionQueryState）把执行完成等待验证
 *   （awaiting_verification）与执行不确定（execution_uncertain，Attempt
 *   interrupted/停止未核验）分开，不把取消接受冒充已停止；
 * - 列表只含 kind='work' 的顶层 Work Session（Chat Session 不混入），复用
 *   计划分页同一规范：limit 默认 50 / 上限 200、plcur_v1_ 受控游标（绑定
 *   数据根 + 项目 + 父级 Run/Task，跨项目/跨父级/跨根重放一律
 *   invalid_cursor）；排序键为（Attempt number, Session id）复合键；
 * - 跨项目/不存在目标统一 undefined（应用层折叠为 not_found，不泄漏存在
 *   性）；visibility 非法形状为可信装配编程错误（TypeError）。
 */
import { PublicError, WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import type { ArtifactRecord } from './artifact-store.js';
import type {
  AttemptExecutionStage,
  AttemptRecord,
  AttemptStatus,
  AttemptUsageSummary,
  WorkspaceLeaseRecord,
} from './attempt-store.js';
import type {
  AttemptNotificationDiagnosticRecord,
  ExecutionListRequest,
  ExecutionRecordPage,
  PublicOccupancyRecord,
} from './execution-schedule-query.js';
import {
  validateRuntimeExecutionResult,
  validateRuntimeStopEvidence,
  RUNTIME_ERROR_KINDS,
} from './runtime-execution.js';
import type {
  RuntimeErrorKind,
  RuntimeExecutionResult,
  RuntimeStopEvidence,
} from './runtime-execution.js';
import { RUNTIME_FAILURE_CATEGORIES } from './runtime-failure.js';
import type { RuntimeControlFacts } from './runtime-settlement.js';
import type { WorkSessionNativeRef, WorkSessionRecord, WorkSessionStatus } from './work-session.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requirePlainObject,
  validateNonNegativeInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 查询操作身份（PublicError.operation 与后续 Host 路由共用；Host 接线属 F-012）
 * ------------------------------------------------------------------ */

export const EXECUTION_WORK_SESSIONS_LIST_OPERATION = 'execution.sessions.list' as const;
export const EXECUTION_WORK_SESSION_GET_OPERATION = 'execution.session.get' as const;
export const EXECUTION_WORK_SESSION_EVIDENCE_OPERATION = 'execution.session.evidence.get' as const;

export const WORK_SESSION_QUERY_OPERATIONS = [
  EXECUTION_WORK_SESSIONS_LIST_OPERATION,
  EXECUTION_WORK_SESSION_GET_OPERATION,
  EXECUTION_WORK_SESSION_EVIDENCE_OPERATION,
] as const;

export type WorkSessionQueryOperation = (typeof WORK_SESSION_QUERY_OPERATIONS)[number];

/* ------------------------------------------------------------------ *
 * 有界常量与受控 locator 前缀（证据成员资格唯一依据，绝不接受任意路径）
 * ------------------------------------------------------------------ */

/** 详情视图证据引用索引行的单次读取上限（超出置 evidenceTruncated）。 */
export const WORK_SESSION_DETAIL_EVIDENCE_MAX_COUNT = 64;
/** 详情视图迟到/越权通知诊断的单次读取上限（超出置 diagnosticsTruncated）。 */
export const WORK_SESSION_DETAIL_DIAGNOSTICS_MAX_COUNT = 32;
/** 证据正文读取缓冲上限（与证据采集器总量上限同量级；超出即失败）。 */
export const WORK_SESSION_EVIDENCE_MAX_READ_BYTES = 8_388_608;
/** 结算/未启动证据正文的读取上限（小 JSON；超出即失败）。 */
export const WORK_SESSION_SETTLEMENT_MAX_READ_BYTES = 1_048_576;

const SETTLEMENT_FAILURE_REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SETTLEMENT_GAP_MAX_COUNT = 32;
const SETTLEMENT_GAP_MAX_LENGTH = 256;

/** Session 证据制品的受控 locator 前缀（发布方固定形态，绝不来自请求数据）。 */
export function workSessionEvidenceLocatorPrefixes(
  sessionId: string | null,
  attemptId: string,
): readonly string[] {
  return sessionId === null
    ? [`attempts/${attemptId}/`]
    : [`sessions/${sessionId}/`, `attempts/${attemptId}/`];
}

/** 制品 locator 是否属于该 Session/Attempt 的诊断证据成员（精确前缀比较，不用 LIKE）。 */
export function isWorkSessionEvidenceLocator(
  locator: string,
  sessionId: string | null,
  attemptId: string,
): boolean {
  return workSessionEvidenceLocatorPrefixes(sessionId, attemptId).some((prefix) =>
    locator.startsWith(prefix),
  );
}

/* ------------------------------------------------------------------ *
 * 一致读视图与窄读取端口（adapters 层实现；应用层授权完成后调用）
 * ------------------------------------------------------------------ */

/** 列表行：顶层 Work Session + 所属 Attempt（同一读事务内 JOIN 解析）。 */
export interface WorkSessionAttemptRow {
  readonly session: WorkSessionRecord;
  readonly attempt: AttemptRecord;
}

/**
 * Session 详情一致读视图：Attempt + 顶层 Work Session（可能尚未创建，如启动
 * 前拒绝）+ 该 Attempt 的 retained 占用 + 受控 locator 前缀内的诊断证据索引
 * 行 + 有界迟到/越权通知诊断，全部在同一 DEFERRED 读事务内取得。
 */
export interface WorkSessionDetailView {
  readonly attempt: AttemptRecord;
  /** 顶层 Work Session；启动前拒绝等场景为 null（明确无 Session，不伪造）。 */
  readonly session: WorkSessionRecord | null;
  /** 该 Attempt 的 retained 占用（held/quarantined；resourceKey 是哈希键）。 */
  readonly occupancy: readonly WorkspaceLeaseRecord[];
  /** 受控前缀内的诊断证据索引行（locator 稳定序；有界）。 */
  readonly evidence: readonly ArtifactRecord[];
  readonly evidenceTruncated: boolean;
  /** 迟到/越权通知诊断（occurred_at, id 稳定序；有界；脱敏形状同既有审计）。 */
  readonly diagnostics: readonly AttemptNotificationDiagnosticRecord[];
  readonly diagnosticsTruncated: boolean;
}

/**
 * Work Session 查询窄读取端口：只读（无任何写原语）；跨项目/不存在目标统一
 * undefined（可见性与存在性折叠由应用层统一为 not_found，不泄漏存在性）；
 * 列表沿用计划分页的可见范围谓词与键集分页形态（复合排序键由
 * ExecutionListRequest 承载，应用层已解码校验）。
 */
export interface WorkSessionQueryReadStore {
  /** Run 存在性折叠辅助（不读内容，只核对同项目归属）。 */
  readRunRef(projectId: unknown, runId: unknown): { readonly id: string } | undefined;
  listRunWorkSessions(
    visibility: unknown,
    projectId: unknown,
    runId: unknown,
    request: ExecutionListRequest,
  ): ExecutionRecordPage<WorkSessionAttemptRow>;
  listTaskWorkSessions(
    visibility: unknown,
    projectId: unknown,
    taskId: unknown,
    request: ExecutionListRequest,
  ): ExecutionRecordPage<WorkSessionAttemptRow>;
  readWorkSessionDetail(projectId: unknown, attemptId: unknown): WorkSessionDetailView | undefined;
}

/* ------------------------------------------------------------------ *
 * 派生展示分类（纯函数；执行完成等待验证与执行不确定分开，不冒充验收）
 * ------------------------------------------------------------------ */

export const WORK_SESSION_QUERY_STATES = [
  /** Session 启动预占（reserved）或 Attempt 尚在 preparing 且 Session 未创建。 */
  'preparing',
  /** Session 已启动（started），执行进行中。 */
  'running',
  /** 执行已结束（ended/stopped）但业务结算未定（Attempt 仍 preparing/executing）。 */
  'settling',
  /** 执行完成，等待验证（Attempt verifying）；verifying 不是验收通过。 */
  'awaiting_verification',
  /** 执行不确定（Attempt interrupted：停止未核验/中断保留现场）。 */
  'execution_uncertain',
  'failed',
  'cancelled',
  'succeeded',
] as const;
export type WorkSessionQueryState = (typeof WORK_SESSION_QUERY_STATES)[number];

/**
 * 从持久 Attempt/Session 事实派生展示分类（确定性映射，不落库）：
 * Attempt 终态优先；活动 Attempt 按 Session 状态细分；Session 尚未创建
 * （启动前拒绝）为 preparing。绝不由该分类推断验收通过或安全停止。
 */
export function deriveWorkSessionQueryState(
  attempt: Pick<AttemptRecord, 'status'>,
  session: Pick<WorkSessionRecord, 'status'> | null,
): WorkSessionQueryState {
  const status: AttemptStatus = attempt.status;
  if (status === 'verifying') return 'awaiting_verification';
  if (status === 'interrupted') return 'execution_uncertain';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'succeeded') return 'succeeded';
  if (session === null || session.status === 'reserved') return 'preparing';
  if (session.status === 'started') return 'running';
  return 'settling';
}

/* ------------------------------------------------------------------ *
 * 持久结算/未启动证据正文（Artifact body）的 fail-closed 校验
 * ------------------------------------------------------------------ */

/** 结算证据的持久正文（sessions/<id>/runtime-settlement.json；schemaVersion 1）。 */
export interface WorkSessionSettlementEvidence {
  readonly kind: 'runtime-settlement';
  readonly result: RuntimeExecutionResult | null;
  readonly failure: { readonly kind: RuntimeErrorKind; readonly reason: string } | null;
  readonly recording: {
    readonly complete: boolean;
    readonly manifestRef: string | null;
    readonly failure: string | null;
    readonly gaps: readonly string[];
    readonly watermark: number | null;
  };
  readonly stop: {
    readonly evidence: RuntimeStopEvidence | null;
    readonly failure: string | null;
  };
  readonly control: RuntimeControlFacts | null;
}

/** 未启动拒绝证据的持久正文（attempts/<id>/launch-rejection.json；schemaVersion 1）。 */
export interface WorkSessionLaunchRejectionEvidence {
  readonly kind: 'runtime-not-started';
  readonly failure: { readonly kind: RuntimeErrorKind; readonly reason: string };
  readonly gaps: readonly string[];
}

export type WorkSessionResultEvidence = WorkSessionSettlementEvidence | WorkSessionLaunchRejectionEvidence;

const EVIDENCE_CONTEXT: ValidationContext = { operation: 'WorkSessionQuery.resultEvidence' };

function boundedToken(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SETTLEMENT_FAILURE_REASON_PATTERN.test(value)) {
    throw validationError(EVIDENCE_CONTEXT, field, '必须是受限 token', typeof value);
  }
  return value;
}

function nullableToken(value: unknown, field: string): string | null {
  if (value === null) return null;
  return boundedToken(value, field);
}

function boundedGaps(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > SETTLEMENT_GAP_MAX_COUNT) {
    throw validationError(EVIDENCE_CONTEXT, field, `必须是有界缺口摘要数组（≤${SETTLEMENT_GAP_MAX_COUNT} 项）`);
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      [...entry].length > SETTLEMENT_GAP_MAX_LENGTH ||
      /[\u0000-\u001F\u007F]/.test(entry)
    ) {
      throw validationError(EVIDENCE_CONTEXT, `${field}[${index}]`, '必须是有界文本');
    }
    return entry;
  });
}

function validateFailure(
  value: unknown,
  field: string,
): { readonly kind: RuntimeErrorKind; readonly reason: string } | null {
  if (value === null) return null;
  const raw = requirePlainObject(value, EVIDENCE_CONTEXT, field);
  rejectUnknownKeys(raw, ['kind', 'reason'], EVIDENCE_CONTEXT, field);
  if (
    typeof raw.kind !== 'string' ||
    !(RUNTIME_ERROR_KINDS as readonly string[]).includes(raw.kind)
  ) {
    throw validationError(EVIDENCE_CONTEXT, `${field}.kind`, 'invalid_kind', raw.kind);
  }
  return { kind: raw.kind as RuntimeErrorKind, reason: boundedToken(raw.reason, `${field}.reason`) };
}

function validateClassificationEnvelope(value: unknown): void {
  if (value === undefined || value === null) return; // Older settlement bodies omit this audit metadata.
  const field = 'evidence.execution.classification';
  const raw = requirePlainObject(value, EVIDENCE_CONTEXT, field);
  rejectUnknownKeys(raw, ['outcome', 'category', 'reason', 'settlementKind', 'evidence'], EVIDENCE_CONTEXT, field);
  if ((raw.outcome !== 'success' && raw.outcome !== 'failure')
    || (raw.category !== null && (typeof raw.category !== 'string' || !(RUNTIME_FAILURE_CATEGORIES as readonly string[]).includes(raw.category)))
    || (raw.outcome === 'success' ? raw.category !== null : raw.category === null)
    || (raw.settlementKind !== null && (typeof raw.settlementKind !== 'string' || !(RUNTIME_ERROR_KINDS as readonly string[]).includes(raw.settlementKind)))) {
    throw validationError(EVIDENCE_CONTEXT, field, 'invalid_classification');
  }
  boundedToken(raw.reason, `${field}.reason`);
  // Detailed diagnostics remain opaque in the verified Artifact, like identity metadata.
  // Never project them publicly or use them to override the validated result/control facts.
  requirePlainObject(raw.evidence, EVIDENCE_CONTEXT, `${field}.evidence`);
}

const CONTROL_REASONS = [
  'user_cancelled', 'service_close', 'runtime_timeout', 'tool_timeout', 'parent_deadline',
  'recording_failed', 'runtime_failed', 'runtime_cancelled', 'stop_unconfirmed',
] as const;
const CONTROL_CANCEL_STATES = ['accepted', 'rejected', 'failed', 'unobserved'] as const;

function validateControl(value: unknown, field: string): RuntimeControlFacts | null {
  if (value === undefined || value === null) return null;
  const raw = requirePlainObject(value, EVIDENCE_CONTEXT, field);
  rejectUnknownKeys(raw, ['reason', 'cancel', 'timeout'], EVIDENCE_CONTEXT, field);
  if (
    typeof raw.reason !== 'string' ||
    !(CONTROL_REASONS as readonly string[]).includes(raw.reason) ||
    typeof raw.cancel !== 'string' ||
    !(CONTROL_CANCEL_STATES as readonly string[]).includes(raw.cancel)
  ) {
    throw validationError(EVIDENCE_CONTEXT, field, 'invalid_control_facts');
  }
  let timeout: RuntimeControlFacts['timeout'];
  if (raw.timeout !== undefined) {
    const t = requirePlainObject(raw.timeout, EVIDENCE_CONTEXT, `${field}.timeout`);
    rejectUnknownKeys(t, ['layer', 'stage', 'limitMs', 'elapsedMs'], EVIDENCE_CONTEXT, `${field}.timeout`);
    if (!['session', 'tool', 'check', 'run', 'batch'].includes(String(t.layer))
      || !['runtime', 'verification'].includes(String(t.stage))) {
      throw validationError(EVIDENCE_CONTEXT, `${field}.timeout`, 'invalid_timeout_facts');
    }
    const nullable = (candidate: unknown, name: string): number | null => {
      if (candidate === null) return null;
      if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw validationError(EVIDENCE_CONTEXT, `${field}.timeout.${name}`, 'invalid_duration');
      }
      return candidate;
    };
    timeout = {
      layer: t.layer as NonNullable<RuntimeControlFacts['timeout']>['layer'],
      stage: t.stage as NonNullable<RuntimeControlFacts['timeout']>['stage'],
      limitMs: nullable(t.limitMs, 'limitMs'),
      elapsedMs: nullable(t.elapsedMs, 'elapsedMs'),
    };
  }
  return {
    reason: raw.reason as RuntimeControlFacts['reason'],
    cancel: raw.cancel as RuntimeControlFacts['cancel'],
    ...(timeout === undefined ? {} : { timeout }),
  };
}

/**
 * 校验持久结果证据正文（读取侧 fail-closed；调用方把任何校验失败折算为
 * corrupt_state，绝不降级为「无证据」）。只识别 Core 自己发布的两种
 * schemaVersion=1 形状；identity 块仅做存在性与归属核验（由调用方比对
 * Session/Attempt），不进入公开投影。
 */
export function validateWorkSessionResultEvidence(value: unknown): WorkSessionResultEvidence {
  const raw = requirePlainObject(value, EVIDENCE_CONTEXT, 'evidence');
  if (raw.schemaVersion !== 1) {
    throw validationError(EVIDENCE_CONTEXT, 'evidence.schemaVersion', '不支持的证据版本', raw.schemaVersion);
  }
  if (raw.kind === 'runtime-not-started') {
    rejectUnknownKeys(
      raw,
      ['schemaVersion', 'kind', 'identity', 'taskId', 'runId', 'failure', 'recording'],
      EVIDENCE_CONTEXT,
      'evidence',
    );
    requirePlainObject(raw.identity, EVIDENCE_CONTEXT, 'evidence.identity');
    validateStableId(raw.taskId, EVIDENCE_CONTEXT, 'evidence.taskId');
    validateStableId(raw.runId, EVIDENCE_CONTEXT, 'evidence.runId');
    const failure = validateFailure(raw.failure, 'evidence.failure');
    if (failure === null) {
      throw validationError(EVIDENCE_CONTEXT, 'evidence.failure', '未启动拒绝必须携带失败分类');
    }
    const recording = requirePlainObject(raw.recording, EVIDENCE_CONTEXT, 'evidence.recording');
    rejectUnknownKeys(recording, ['complete', 'gaps'], EVIDENCE_CONTEXT, 'evidence.recording');
    if (recording.complete !== false) {
      throw validationError(EVIDENCE_CONTEXT, 'evidence.recording.complete', '未启动记录必为 incomplete');
    }
    return {
      kind: 'runtime-not-started',
      failure,
      gaps: boundedGaps(recording.gaps, 'evidence.recording.gaps'),
    };
  }
  if (raw.kind === 'runtime-settlement') {
    rejectUnknownKeys(
      raw,
      ['schemaVersion', 'kind', 'identity', 'execution', 'recording', 'stop', 'control'],
      EVIDENCE_CONTEXT,
      'evidence',
    );
    requirePlainObject(raw.identity, EVIDENCE_CONTEXT, 'evidence.identity');
    const execution = requirePlainObject(raw.execution, EVIDENCE_CONTEXT, 'evidence.execution');
    rejectUnknownKeys(execution, ['result', 'failure', 'classification'], EVIDENCE_CONTEXT, 'evidence.execution');
    validateClassificationEnvelope(execution.classification);
    const recording = requirePlainObject(raw.recording, EVIDENCE_CONTEXT, 'evidence.recording');
    rejectUnknownKeys(
      recording,
      ['complete', 'manifestRef', 'failure', 'gaps', 'watermark'],
      EVIDENCE_CONTEXT,
      'evidence.recording',
    );
    if (typeof recording.complete !== 'boolean') {
      throw validationError(EVIDENCE_CONTEXT, 'evidence.recording.complete', 'invalid_boolean');
    }
    const stop = requirePlainObject(raw.stop, EVIDENCE_CONTEXT, 'evidence.stop');
    rejectUnknownKeys(stop, ['evidence', 'failure'], EVIDENCE_CONTEXT, 'evidence.stop');
    const manifestRef =
      recording.manifestRef === null ? null : validateStableId(recording.manifestRef, EVIDENCE_CONTEXT, 'evidence.recording.manifestRef');
    if (recording.complete && manifestRef === null) {
      throw validationError(EVIDENCE_CONTEXT, 'evidence.recording.manifestRef', 'required_recording_missing');
    }
    return {
      kind: 'runtime-settlement',
      result: execution.result === null ? null : validateRuntimeExecutionResult(execution.result),
      failure: validateFailure(execution.failure, 'evidence.execution.failure'),
      recording: {
        complete: recording.complete,
        manifestRef,
        failure: nullableToken(recording.failure, 'evidence.recording.failure'),
        gaps: boundedGaps(recording.gaps, 'evidence.recording.gaps'),
        watermark:
          recording.watermark === null
            ? null
            : validateNonNegativeInteger(recording.watermark, EVIDENCE_CONTEXT, 'evidence.recording.watermark'),
      },
      stop: {
        evidence: stop.evidence === null ? null : validateRuntimeStopEvidence(stop.evidence),
        failure: nullableToken(stop.failure, 'evidence.stop.failure'),
      },
      control: validateControl(raw.control, 'evidence.control'),
    };
  }
  throw validationError(EVIDENCE_CONTEXT, 'evidence.kind', '不支持的证据类别', raw.kind);
}

/* ------------------------------------------------------------------ *
 * 公开投影（脱敏：剔除 providerSessionId/storage_locator/正文；时间转 ISO UTC）
 * ------------------------------------------------------------------ */

function isoUtc(utcMs: number): string {
  return new Date(utcMs).toISOString();
}

function isoOrNull(utcMs: number | null): string | null {
  return utcMs === null ? null : isoUtc(utcMs);
}

/** 列表行公开投影：关联身份 + Session/执行事实 + 派生展示分类。 */
export interface PublicWorkSessionSummary {
  readonly sessionId: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly status: WorkSessionStatus;
  readonly executionStage: AttemptExecutionStage;
  readonly executionState: WorkSessionQueryState;
  readonly runtime: string;
  readonly adapterVersion: string;
  readonly inputRef: string;
  readonly resultRef: string | null;
  readonly lastActivityAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly stoppedAt: string | null;
  readonly recordingWatermark: number | null;
  /** 记录缺口条数（无缺口记录为 null；摘要在详情）。 */
  readonly recordingGapCount: number | null;
}

export function toPublicWorkSessionSummary(row: WorkSessionAttemptRow): PublicWorkSessionSummary {
  const { session, attempt } = row;
  return {
    sessionId: session.id,
    projectId: session.projectId,
    featureId: attempt.featureId,
    runId: attempt.runId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    attemptNumber: attempt.number,
    status: session.status,
    executionStage: session.executionStage,
    executionState: deriveWorkSessionQueryState(attempt, session),
    runtime: session.runtime,
    adapterVersion: session.adapterVersion,
    inputRef: session.inputRef,
    resultRef: session.resultRef,
    lastActivityAt: isoUtc(session.lastActivityAtUtcMs),
    startedAt: isoOrNull(session.startedAtUtcMs),
    endedAt: isoOrNull(session.endedAtUtcMs),
    stoppedAt: isoOrNull(session.stoppedAtUtcMs),
    recordingWatermark: session.recordingWatermark,
    recordingGapCount: session.recordingGaps === null ? null : session.recordingGaps.length,
  };
}

/** 详情中的 Session 公开投影（providerSessionId 不进入公开面）。 */
export interface PublicWorkSessionRecord {
  readonly id: string;
  readonly status: WorkSessionStatus;
  readonly kind: WorkSessionRecord['kind'];
  readonly purpose: string;
  readonly title: string | null;
  readonly runtime: string;
  readonly adapterVersion: string;
  readonly executionStage: AttemptExecutionStage;
  readonly nativeRef: WorkSessionNativeRef | null;
  readonly inputRef: string;
  readonly resultRef: string | null;
  readonly lastActivityAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly stoppedAt: string | null;
  readonly recordingWatermark: number | null;
  readonly recordingGaps: readonly string[] | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicWorkSessionRecord(record: WorkSessionRecord): PublicWorkSessionRecord {
  return {
    id: record.id,
    status: record.status,
    kind: record.kind,
    purpose: record.purpose,
    title: record.title,
    runtime: record.runtime,
    adapterVersion: record.adapterVersion,
    executionStage: record.executionStage,
    nativeRef: record.nativeRef === null ? null : { ...record.nativeRef },
    inputRef: record.inputRef,
    resultRef: record.resultRef,
    lastActivityAt: isoUtc(record.lastActivityAtUtcMs),
    startedAt: isoOrNull(record.startedAtUtcMs),
    endedAt: isoOrNull(record.endedAtUtcMs),
    stoppedAt: isoOrNull(record.stoppedAtUtcMs),
    recordingWatermark: record.recordingWatermark,
    recordingGaps: record.recordingGaps === null ? null : [...record.recordingGaps],
    revision: record.revision,
    createdAt: isoUtc(record.createdAtUtcMs),
    updatedAt: isoUtc(record.updatedAtUtcMs),
  };
}

/** 详情中的 Attempt 公开投影（未知指标保持 null；不含 inputSnapshot 正文）。 */
export interface PublicWorkSessionAttempt {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly number: number;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly status: AttemptStatus;
  readonly executionStage: AttemptExecutionStage;
  readonly inputDigest: string;
  readonly inputRef: string;
  readonly sessionId: string | null;
  readonly invocationId: string | null;
  readonly errorKind: string | null;
  readonly diagnosticRef: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly usageSummary: AttemptUsageSummary | null;
}

export function toPublicWorkSessionAttempt(record: AttemptRecord): PublicWorkSessionAttempt {
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
    status: record.status,
    executionStage: record.executionStage,
    inputDigest: record.inputDigest,
    inputRef: record.inputRef,
    sessionId: record.sessionId,
    invocationId: record.invocationId,
    errorKind: record.errorKind,
    diagnosticRef: record.diagnosticRef,
    startedAt: isoOrNull(record.startedAtUtcMs),
    endedAt: isoOrNull(record.endedAtUtcMs),
    durationMs: record.durationMs,
    exitCode: record.exitCode,
    usageSummary: record.usageSummary === null ? null : { ...record.usageSummary },
  };
}

/** 证据引用公开投影（索引事实；locator/物理位置不进入公开面）。 */
export interface PublicWorkSessionEvidenceRef {
  readonly artifactId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly status: ArtifactRecord['status'];
  readonly contentHash: string | null;
  readonly sizeBytes: number | null;
  readonly version: number;
}

export function toPublicWorkSessionEvidenceRef(record: ArtifactRecord): PublicWorkSessionEvidenceRef {
  return {
    artifactId: record.id,
    kind: record.kind,
    mediaType: record.mediaType,
    status: record.status,
    contentHash: record.contentHash,
    sizeBytes: record.sizeBytes,
    version: record.version,
  };
}

/** 结果证据公开投影（usage.basis 原样保留——synthetic 显式标记）。 */
export interface PublicWorkSessionResultEvidence {
  readonly kind: WorkSessionResultEvidence['kind'];
  readonly result: RuntimeExecutionResult | null;
  readonly failure: { readonly kind: RuntimeErrorKind; readonly reason: string } | null;
  readonly recording: {
    readonly complete: boolean;
    readonly manifestRef: string | null;
    readonly failure: string | null;
    readonly gaps: readonly string[];
    readonly watermark: number | null;
  };
  readonly stop: {
    readonly evidence: RuntimeStopEvidence | null;
    readonly failure: string | null;
  };
  readonly control: RuntimeControlFacts | null;
}

export function toPublicWorkSessionResultEvidence(
  evidence: WorkSessionResultEvidence,
): PublicWorkSessionResultEvidence {
  if (evidence.kind === 'runtime-not-started') {
    return {
      kind: evidence.kind,
      result: null,
      failure: evidence.failure,
      recording: { complete: false, manifestRef: null, failure: null, gaps: [...evidence.gaps], watermark: null },
      stop: { evidence: null, failure: null },
      control: null,
    };
  }
  return {
    kind: evidence.kind,
    result: evidence.result,
    failure: evidence.failure,
    recording: { ...evidence.recording, gaps: [...evidence.recording.gaps] },
    stop: evidence.stop,
    control: evidence.control,
  };
}

/** Pure validation of the public projection, shared by HostClient. */
export function validatePublicWorkSessionResultEvidence(value: unknown): PublicWorkSessionResultEvidence {
  const raw = requirePlainObject(value, EVIDENCE_CONTEXT, 'evidence');
  const keys = ['kind', 'result', 'failure', 'recording', 'stop', 'control'];
  rejectUnknownKeys(raw, keys, EVIDENCE_CONTEXT, 'evidence');
  if (keys.some(key => !Object.hasOwn(raw, key))) throw validationError(EVIDENCE_CONTEXT, 'evidence', 'missing_field');
  const recording = requirePlainObject(raw.recording, EVIDENCE_CONTEXT, 'evidence.recording');
  const stop = requirePlainObject(raw.stop, EVIDENCE_CONTEXT, 'evidence.stop');
  rejectUnknownKeys(recording, ['complete', 'manifestRef', 'failure', 'gaps', 'watermark'], EVIDENCE_CONTEXT, 'evidence.recording');
  rejectUnknownKeys(stop, ['evidence', 'failure'], EVIDENCE_CONTEXT, 'evidence.stop');
  if (raw.kind === 'runtime-not-started') {
    if (raw.result !== null || raw.control !== null || recording.complete !== false || recording.manifestRef !== null ||
        recording.failure !== null || recording.watermark !== null || stop.evidence !== null || stop.failure !== null) {
      throw validationError(EVIDENCE_CONTEXT, 'evidence', 'invalid_unstarted_projection');
    }
    return toPublicWorkSessionResultEvidence(validateWorkSessionResultEvidence({ schemaVersion: 1, kind: raw.kind,
      identity: {}, taskId: 'projection', runId: 'projection', failure: raw.failure,
      recording: { complete: false, gaps: recording.gaps } }));
  }
  return toPublicWorkSessionResultEvidence(validateWorkSessionResultEvidence({ schemaVersion: 1, kind: raw.kind,
    identity: {}, execution: { result: raw.result, failure: raw.failure }, recording, stop, control: raw.control }));
}

/* ------------------------------------------------------------------ *
 * 查询结果信封
 * ------------------------------------------------------------------ */

export interface WorkSessionListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'work-session-list';
  readonly records: readonly PublicWorkSessionSummary[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface WorkSessionDetailResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'work-session';
  readonly attempt: PublicWorkSessionAttempt;
  /** 派生展示分类（awaiting_verification 与 execution_uncertain 分开）。 */
  readonly executionState: WorkSessionQueryState;
  readonly session: PublicWorkSessionRecord | null;
  /** 结果证据投影（经完整性核验读取；无证据为 null）。 */
  readonly resultEvidence: PublicWorkSessionResultEvidence | null;
  readonly occupancy: readonly PublicOccupancyRecord[];
  readonly evidence: readonly PublicWorkSessionEvidenceRef[];
  readonly evidenceTruncated: boolean;
  readonly diagnostics: readonly {
    readonly id: string;
    readonly projectId: string;
    readonly attemptId: string;
    readonly notificationDigest: string;
    readonly reason: AttemptNotificationDiagnosticRecord['reason'];
    readonly occurredAt: string;
  }[];
  readonly diagnosticsTruncated: boolean;
}

/** execution.session.evidence.get 的授权正文结果（传输层以有界字节输出）。 */
export interface WorkSessionEvidenceContent {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'work-session-evidence';
  readonly artifact: {
    readonly artifactId: string;
    readonly kind: string;
    readonly mediaType: string;
    readonly contentHash: string;
    readonly sizeBytes: number;
    readonly version: number;
  };
  readonly content: Uint8Array;
}

/* ------------------------------------------------------------------ *
 * 列表输入校验（应用层调用；取值规则单一权威）
 * ------------------------------------------------------------------ */

export interface ValidatedWorkSessionListSelector {
  readonly parent: { readonly kind: 'run'; readonly runId: string } | { readonly kind: 'task'; readonly taskId: string };
}

/**
 * 列表父级选择器校验：runId 与 taskId 必须恰好其一（都没有/都给出均为
 * invalid_input）；projectId/limit/cursor 由应用层按既有规范单独校验。
 */
export function validateWorkSessionListSelector(
  input: unknown,
  operation: string,
): ValidatedWorkSessionListSelector {
  const context: ValidationContext = { operation };
  const raw = requirePlainObject(input, context, 'input');
  rejectUnknownKeys(raw, ['projectId', 'runId', 'taskId', 'limit', 'cursor'], context, 'input');
  const hasRun = raw.runId !== undefined && raw.runId !== null;
  const hasTask = raw.taskId !== undefined && raw.taskId !== null;
  if (hasRun === hasTask) {
    throw new PublicError('invalid_input', operation, undefined, {
      details: { field: hasRun ? 'taskId' : 'runId', reason: hasRun ? 'parent_conflict' : 'parent_required' },
    });
  }
  if (hasRun) {
    return {
      parent: {
        kind: 'run',
        runId: validateStableId(raw.runId, { operation, entity: { type: 'run' } }, 'runId'),
      },
    };
  }
  return {
    parent: {
      kind: 'task',
      taskId: validateStableId(raw.taskId, { operation, entity: { type: 'task' } }, 'taskId'),
    },
  };
}
