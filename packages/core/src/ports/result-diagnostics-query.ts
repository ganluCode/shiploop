/**
 * P07-4 / F-001 结果诊断分页查询契约（ports 纯契约层）。
 *
 * 设计依据：p07-result-notifications PRD FR-1（输入：授权
 * Project/Batch/Run/Attempt/Session 身份及分页；输出：状态、代码/检查/记录
 * 引用、Token、缺口和交付结果）、设计 05 §9（Runtime 完成 ≠ Task 验收 ≠
 * Feature 交付）、08 §2（Host/CLI 查询契约）与既有查询纪律
 * （docs/phases/p03/p03-4-schedule-query-contract.md 同一分页/游标/只读规范）。
 *
 * 不变量：
 * - 复用既有事实源：Attempt/Run/Batch/Task/Feature 持久行、verification 批次
 *   与 check_results、git_operations、execution_stop_operations、
 *   attempt_notification_diagnostics、Work Session 及其受控 locator 证据索引；
 *   不建立第二套可写状态，不派生落库新事实；
 * - 三轴区分：runtime（Attempt/Session 执行状态，复用
 *   deriveWorkSessionQueryState）、task（Task 状态 + 独立验证批次）、
 *   feature（Feature 状态 + delivery 状态）；Runtime 成功绝不冒充 Task 验收
 *   或 Feature 交付；
 * - 停止/阻塞原因只来自持久事实（run.reason、停止操作状态、迟到/越权通知
 *   诊断、人工阻塞 pending 项）；需处理动作由
 *   deriveResultPendingActions 确定性派生，词汇冻结，不猜测量化语义；
 * - 未知指标保持 null（时间/退出码/Token/水位），不以 0 冒充；用量复用
 *   application/usage-normalization 归一化与聚合（Attempt 终值观察一次计入，
 *   不叠加 Session 明细或父级汇总）；
 * - 列表复用计划分页同一规范：limit 默认 50 / 上限 200、plcur_v1_ 受控游标
 *   （绑定数据根 + 项目 + 父级 Batch/Run/Attempt/Session + 范围，跨项目/跨
 *   父级/跨根重放一律 invalid_cursor）；排序键为（Attempt number, Attempt id）
 *   复合键，键集分页稳定；
 * - 查询面零写入、零事件、零唤醒：不创建 Attempt、不扣预算、不触发取消、
 *   Git 或执行；不接受任意文件路径（证据只按 Session/Attempt 受控 locator
 *   前缀的制品成员资格）；
 * - 跨项目/不存在目标统一 undefined（应用层折叠为 not_found，不泄漏存在性）。
 */
import { PublicError, WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import type { AttemptStatus, AttemptRecord } from './attempt-store.js';
import type { TaskStatus, FeatureStatus } from './plan-store.js';
import type { ExecutionBatchStatus, ExecutionRunStatus } from './execution-store.js';
import type { FeatureDeliveryStatus } from './git-operations.js';
import type { WorkSessionRecord } from './work-session.js';
import type { WorkSessionQueryState } from './work-session-query.js';
import type { WorkRecordingManifestRecord } from './work-recording.js';
import type { PublicWorkRecordingManifestSummary } from './work-recording-query.js';
import type { ArtifactRecord } from './artifact-store.js';
import type {
  AttemptNotificationDiagnosticRecord,
  ExecutionListCursorKey,
  ExecutionListRequest,
} from './execution-schedule-query.js';
import type { BatchDeliveryStopRecord } from './batch-delivery-query.js';
import { validateStableId, validationError } from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 查询操作身份（PublicError.operation 与后续 Host 路由共用；Host/CLI 接线属 F-003）
 * ------------------------------------------------------------------ */

export const EXECUTION_RESULT_DIAGNOSTICS_LIST_OPERATION = 'execution.result.diagnostics.list' as const;

/** 父级选择器键（请求面只允许其中恰好一个）。 */
export const RESULT_DIAGNOSTICS_PARENT_KEYS = ['batchId', 'runId', 'attemptId', 'workSessionId'] as const;

/** 已归一化的父级身份（恰好一个；与游标 scope 的 parentKind/parentId 对应）。 */
export type ResultDiagnosticsParent =
  | { readonly kind: 'batch'; readonly batchId: string }
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'attempt'; readonly attemptId: string }
  | { readonly kind: 'session'; readonly sessionId: string };

/** 请求选择器校验：projectId 之外的父级键必须恰好提供一个（非法先于读取拒绝）。 */
export function validateResultDiagnosticsSelector(
  value: Record<string, unknown>,
  operation: string,
): ResultDiagnosticsParent {
  const context: ValidationContext = { operation, entity: { type: 'project' } };
  const provided = RESULT_DIAGNOSTICS_PARENT_KEYS.filter(key => value[key] !== undefined);
  if (provided.length === 0) {
    throw validationError(context, 'selector', `必须恰好提供 ${RESULT_DIAGNOSTICS_PARENT_KEYS.join(' / ')} 之一`);
  }
  if (provided.length > 1) {
    throw validationError(context, 'selector', 'batchId / runId / attemptId / workSessionId 只能提供一个', provided);
  }
  const key = provided[0];
  const id = validateStableId(value[key], { operation, entity: { type: key === 'batchId' ? 'execution_batch' : key === 'runId' ? 'run' : key === 'attemptId' ? 'attempt' : 'work_session' } }, key);
  if (key === 'batchId') return { kind: 'batch', batchId: id };
  if (key === 'runId') return { kind: 'run', runId: id };
  if (key === 'attemptId') return { kind: 'attempt', attemptId: id };
  return { kind: 'session', sessionId: id };
}

/* ------------------------------------------------------------------ *
 * 单条结果诊断行（一致读视图内组装；adapters 层实现映射）
 * ------------------------------------------------------------------ */

/** Run/Batch 归属事实（同项目防御复核由适配器执行）。 */
export interface ResultDiagnosticsRunFacts {
  readonly runId: string;
  readonly batchId: string;
  readonly runStatus: ExecutionRunStatus;
  readonly runReason: string | null;
}

/** Task/Feature 验收与交付轴的持久事实。 */
export interface ResultDiagnosticsPlanFacts {
  readonly taskStatus: TaskStatus;
  readonly featureStatus: FeatureStatus;
  readonly featureDeliveryStatus: FeatureDeliveryStatus;
  /** 该 Task 是否存在未决人工阻塞项（kind='block' 且 status='pending'）。 */
  readonly manualBlockPending: boolean;
}

/** 检查引用：该 Task 最新验证批次（无则 null）。 */
export interface ResultDiagnosticsCheckRef {
  readonly batchId: string;
  readonly operation: string;
  readonly status: string;
  readonly endedAtUtcMs: number | null;
  readonly checks: readonly { readonly checkKey: string; readonly status: string; readonly outputArtifactId: string | null }[];
}

/** Git 交付引用（仅身份级事实）。 */
export interface ResultDiagnosticsGitRef {
  readonly operationId: string;
  readonly operationType: string;
  readonly status: string;
}

/** 每条记录的有界附加上限（超出置对应 truncated 标志，不静默丢弃计数语义）。 */
export const RESULT_DIAGNOSTICS_STOP_OPERATIONS_MAX_COUNT = 32;
export const RESULT_DIAGNOSTICS_VERIFICATION_CHECKS_MAX_COUNT = 32;
export const RESULT_DIAGNOSTICS_GIT_OPERATIONS_MAX_COUNT = 16;
/** P07-4 / F-002：Recorder 清单投影按 Work Session 数的上限（超出置 truncated）。 */
export const RESULT_DIAGNOSTICS_RECORDER_MANIFESTS_MAX_COUNT = 16;

/** Recorder 事实（P07-4 / F-002）：每 Work Session 最新清单元数据（有界，不含正文）。 */
export interface ResultDiagnosticsRecorderFacts {
  readonly manifests: readonly WorkRecordingManifestRecord[];
  readonly truncated: boolean;
}

/** 结果诊断行：一个 Attempt 的完整定位事实（同一读事务内取得）。 */
export interface ResultDiagnosticsRow {
  readonly attempt: AttemptRecord;
  /** 顶层 Work Session（启动前拒绝等场景为 null，明确无 Session，不伪造）。 */
  readonly session: WorkSessionRecord | null;
  readonly run: ResultDiagnosticsRunFacts;
  readonly plan: ResultDiagnosticsPlanFacts;
  /** 迟到/越权通知诊断（有界；复用既有冻结词汇）。 */
  readonly diagnostics: readonly AttemptNotificationDiagnosticRecord[];
  readonly diagnosticsTruncated: boolean;
  /** 与该 Attempt/Run 相关的停止操作（有界；含 run 与所属 batch 目标）。 */
  readonly stopOperations: readonly BatchDeliveryStopRecord[];
  readonly stopOperationsTruncated: boolean;
  /** 该 Task 最新验证批次引用（无验证记录为 null）。 */
  readonly verification: ResultDiagnosticsCheckRef | null;
  readonly verificationChecksTruncated: boolean;
  /** 该 Run 的 Git 操作引用（有界）。 */
  readonly gitOperations: readonly ResultDiagnosticsGitRef[];
  readonly gitOperationsTruncated: boolean;
  /** 受控 locator 前缀内的证据索引行（有界；正文由应用层按需核验读取）。 */
  readonly evidence: readonly ArtifactRecord[];
  readonly evidenceTruncated: boolean;
  /** Recorder 清单事实（无 Work Session 为 null；只读元数据，不扫正文）。 */
  readonly recorder: ResultDiagnosticsRecorderFacts | null;
}

/** 父级范围摘要（定位入口；不含正文）。 */
export type ResultDiagnosticsScope =
  | { readonly kind: 'batch'; readonly batchId: string; readonly batchStatus: ExecutionBatchStatus }
  | { readonly kind: 'run'; readonly runId: string; readonly batchId: string; readonly runStatus: ExecutionRunStatus; readonly runReason: string | null }
  | { readonly kind: 'attempt'; readonly attemptId: string; readonly runId: string; readonly batchId: string }
  | { readonly kind: 'session'; readonly sessionId: string; readonly attemptId: string; readonly runId: string; readonly batchId: string };

/** 结果诊断页：父级摘要 + 键集分页行 + 同一读视图内的事件水位。 */
export interface ResultDiagnosticsPage {
  readonly scope: ResultDiagnosticsScope;
  readonly records: readonly ResultDiagnosticsRow[];
  /** 用满 limit 时的末条复合键（供应用层编码游标），否则 null。 */
  readonly nextKey: ExecutionListCursorKey | null;
  /** 该读视图内项目事件水位（参考事实；不证明历史指标全部已记录）。 */
  readonly eventWatermark: number;
}

/**
 * 结果诊断窄读取端口：只读；跨项目/不存在目标统一 undefined（应用层折叠为
 * not_found）；每次调用在单一一致读事务内组装整页。
 */
export interface ResultDiagnosticsQueryReadStore {
  readResultDiagnosticsPage(
    projectId: unknown,
    parent: ResultDiagnosticsParent,
    request: ExecutionListRequest,
  ): ResultDiagnosticsPage | undefined;
}

/* ------------------------------------------------------------------ *
 * 需处理动作派生（纯函数；词汇冻结；只依据持久事实）
 * ------------------------------------------------------------------ */

export const RESULT_PENDING_ACTIONS = [
  'await_runtime_start',
  'await_independent_verification',
  'confirm_stop_uncertainty',
  'await_stop_confirmation',
  'resume_or_cancel_run',
  'review_manual_block',
  'rework_task',
  'restart_run',
  'request_feature_delivery',
  'review_delivery_failure',
] as const;
export type ResultPendingAction = (typeof RESULT_PENDING_ACTIONS)[number];

export interface ResultPendingActionFacts {
  readonly attemptStatus: AttemptStatus;
  readonly executionState: WorkSessionQueryState;
  readonly runStatus: ExecutionRunStatus;
  /** 该 Attempt/Run 相关停止操作的最不利状态（无则 null）。 */
  readonly stopStatus: BatchDeliveryStopRecord['status'] | null;
  readonly manualBlockPending: boolean;
  readonly taskStatus: TaskStatus;
  readonly featureStatus: FeatureStatus;
  readonly featureDeliveryStatus: FeatureDeliveryStatus;
}

/** 人工阻塞 > 停止不确定 > 停止进行中 > 运行恢复 > 执行推进 > 返工/重启 > 交付。 */
export function deriveResultPendingActions(facts: ResultPendingActionFacts): readonly ResultPendingAction[] {
  const actions: ResultPendingAction[] = [];
  if (facts.manualBlockPending) actions.push('review_manual_block');
  if (facts.stopStatus === 'uncertain' || facts.executionState === 'execution_uncertain') actions.push('confirm_stop_uncertainty');
  else if (facts.stopStatus === 'stopping' || facts.runStatus === 'pausing' || facts.runStatus === 'cancelling') actions.push('await_stop_confirmation');
  if (facts.runStatus === 'paused') actions.push('resume_or_cancel_run');
  if (facts.executionState === 'preparing') actions.push('await_runtime_start');
  if (facts.executionState === 'awaiting_verification') actions.push('await_independent_verification');
  const taskNotSettled = facts.taskStatus !== 'passed' && facts.taskStatus !== 'skipped';
  const runtimeFailed = facts.attemptStatus === 'failed' || facts.attemptStatus === 'cancelled' || facts.attemptStatus === 'interrupted';
  if (runtimeFailed && taskNotSettled) actions.push('rework_task');
  if (['failed', 'interrupted', 'cancelled'].includes(facts.runStatus) && taskNotSettled) actions.push('restart_run');
  if (facts.featureStatus === 'completed' && facts.featureDeliveryStatus === 'not_requested') actions.push('request_feature_delivery');
  if (facts.featureDeliveryStatus === 'failed') actions.push('review_delivery_failure');
  return [...new Set(actions)];
}

/** 停止/阻塞原因（持久事实词汇；不猜测量化语义）。 */
export function deriveResultBlockReasons(
  runReason: string | null,
  stopOperations: readonly BatchDeliveryStopRecord[],
  diagnostics: readonly AttemptNotificationDiagnosticRecord[],
  manualBlockPending: boolean,
): readonly string[] {
  const reasons: string[] = [];
  if (runReason !== null) reasons.push(`run:${runReason}`);
  for (const status of new Set(stopOperations.map(stop => stop.status))) reasons.push(`stop:${status}`);
  for (const reason of new Set(diagnostics.map(item => item.reason))) reasons.push(`notification:${reason}`);
  if (manualBlockPending) reasons.push('manual_block_pending');
  return reasons.sort();
}

/* ------------------------------------------------------------------ *
 * 公开形状（应用层组装后；Host/CLI 接线属 F-003）
 * ------------------------------------------------------------------ */

/** 单条记录用量摘要（未知维度保持 null；coverage 标明覆盖）。 */
export interface PublicResultUsageSummary {
  readonly basis: 'synthetic' | 'reported' | 'unknown';
  readonly coverage: 'reported' | 'partial' | 'unknown';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly costMicros: number | null;
  readonly currency: string | null;
}

/** 页级用量聚合：仅由本页各 Attempt 终值观察各计一次聚合（不叠加父级）。 */
export interface PublicResultPageUsage {
  readonly basis: 'synthetic' | 'reported' | 'mixed' | 'none';
  readonly coverage: 'reported' | 'partial' | 'unknown';
  readonly accounting: 'incremental' | 'cumulative' | 'unknown';
  readonly countedObservations: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly costMicros: number | null;
  readonly diagnostics: readonly string[];
}

/** Runtime 执行轴（Runtime 完成 ≠ Task 验收）。 */
export interface PublicResultRuntimeAxis {
  readonly attemptStatus: AttemptStatus;
  /** 复用 deriveWorkSessionQueryState 的展示分类（verifying 不是验收通过）。 */
  readonly state: WorkSessionQueryState;
  readonly sessionStatus: WorkSessionRecord['status'] | null;
  /** 结果证据正文已核验且身份绑定一致；false 不代表执行失败。 */
  readonly resultKnown: boolean;
  readonly exitCode: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
}

/** Task 验收轴（独立 Verifier 事实）。 */
export interface PublicResultTaskAxis {
  readonly taskStatus: TaskStatus;
  readonly manualBlockPending: boolean;
  readonly verification: {
    readonly batchId: string;
    readonly operation: string;
    readonly status: string;
    readonly endedAt: string | null;
    readonly checks: readonly { readonly checkKey: string; readonly status: string; readonly outputArtifactId: string | null }[];
  } | null;
}

/** Feature 交付轴（最终交付状态）。 */
export interface PublicResultFeatureAxis {
  readonly featureStatus: FeatureStatus;
  readonly deliveryStatus: FeatureDeliveryStatus;
}

/** 公开结果诊断记录（身份/状态/原因/动作/引用/覆盖；不含正文与物理路径）。 */
export interface PublicResultDiagnosticRecord {
  readonly attemptId: string;
  readonly number: number;
  readonly taskId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly executionStage: AttemptRecord['executionStage'];
  readonly rework: { readonly previousAttemptId: string } | null;
  readonly recovery: { readonly sourceAttemptId: string | null; readonly selection: string } | null;
  readonly runtime: PublicResultRuntimeAxis;
  readonly task: PublicResultTaskAxis;
  readonly feature: PublicResultFeatureAxis;
  readonly blockReasons: readonly string[];
  readonly pendingActions: readonly ResultPendingAction[];
  readonly codeRef: string | null;
  readonly diagnosticRef: string | null;
  readonly resultArtifactId: string | null;
  /** 结果证据正文实际核验引用（含 launch-rejection 回退；无证据为 null）。 */
  readonly resultEvidenceRef: string | null;
  readonly checkRefs: readonly { readonly batchId: string; readonly operation: string; readonly status: string; readonly endedAt: string | null }[];
  readonly gitOperationRefs: readonly ResultDiagnosticsGitRef[];
  readonly recording: {
    readonly complete: boolean;
    readonly manifestRef: string | null;
    readonly failure: string | null;
    readonly gaps: readonly string[];
    readonly watermark: number | null;
  } | null;
  /** P07-4 / F-002 Recorder 真实事实（无 Work Session 为 null）：coverage/水位/截断/脱敏/缺失原因。 */
  readonly recorder: {
    readonly sessions: readonly PublicWorkRecordingManifestSummary[];
    readonly truncated: boolean;
  } | null;
  readonly usage: PublicResultUsageSummary;
  readonly issues: readonly string[];
}

export interface ResultDiagnosticsListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'result-diagnostics';
  readonly parent: ResultDiagnosticsParent;
  readonly parentFacts: ResultDiagnosticsScope;
  readonly records: readonly PublicResultDiagnosticRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly eventWatermark: number;
  readonly usage: PublicResultPageUsage;
}

export function resultDiagnosticsParentId(parent: ResultDiagnosticsParent): string {
  switch (parent.kind) {
    case 'batch': return parent.batchId;
    case 'run': return parent.runId;
    case 'attempt': return parent.attemptId;
    case 'session': return parent.sessionId;
  }
}

/** 应用层输入白名单（projectId + 恰一父级键 + limit/cursor）。 */
export const RESULT_DIAGNOSTICS_INPUT_KEYS = ['projectId', ...RESULT_DIAGNOSTICS_PARENT_KEYS, 'limit', 'cursor'] as const;
