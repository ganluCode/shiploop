/**
 * P03-7 / F-013 Task 机器证据、人审事项与有限返工链授权只读查询面（ports 层）。
 *
 * 契约要点（docs/p03-7-f013-task-evidence-query-contract.md）：
 * - 三个查询操作分别展示「Task 机器证据」「独立人审事项」「有限返工链」，
 *   不把机器结论折算成有效 Task 状态：机器 passed 只出现在 machine.status，
 *   有效 Task passed 恒以 task.status === 'passed' 为准（effectivePassed）；
 * - 全部内容取自持久 SQLite 一致读视图（TaskEvidenceQueryReadStore），查询
 *   零写入、零事件、不触发 Runtime、不扣预算、不续租；
 * - 批次/检查展示保留选择/回退理由（selection）、代码身份（codeDigest/
 *   policyDigest/environmentSummary）与逐检查输出 Artifact/tail 引用；证据
 *   正文完整性核验由既有 ArtifactVerifier 完成，损坏即 corrupt_state
 *   fail-closed，绝不降级为「无证据」；
 * - 返工链保留历次 Attempt 与失败引用（errorKind/codeRef/diagnosticRef），
 *   未知退出码/耗时保持 null（不以 0 冒充）；代码资格已用/剩余只取持久计数
 *   与策略副本上限，基础设施错误与等待人审不显示为代码额度消耗；
 * - 分页沿用既有有界分页/受控游标规范（人审事项 id 键集 + plcur_v1_ 游标；
 *   返工链 (number,id) 复合键 + 既有执行列表键编码）；跨项目/跨 Task/跨根
 *   游标重放一律 invalid_cursor，越权/跨项目/不存在统一 not_found。
 */
import {
  CODE_ATTEMPT_SETTLEMENT_PREFIX,
  type CodeAttemptOutcome,
} from './code-attempt-budget.js';
import {
  evaluateTaskCodeAttemptReservation,
  resolveTaskAttemptCaps,
  type TaskAttemptCaps,
} from './execution-budget.js';
import type {
  ExecutionListRequest,
  ExecutionRecordPage,
} from './execution-schedule-query.js';
import type { AttemptRecord, AttemptStatus, AttemptExecutionStage } from './attempt-store.js';
import type { PublicExecutionBudgetBlockReason } from './execution-budget-query.js';
import type { ExecutionRunStatus } from './execution-store.js';
import type { TaskApprovalItemRecord, TaskStatus } from './plan-store.js';
import type {
  CheckResultRecord,
  CheckResultStatus,
  VerificationBatchRecord,
  VerificationBatchStatus,
  VerificationSelectionSnapshot,
} from './verification-store.js';
import type { TaskDagReason } from './task-dag.js';
import { WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import { StorageError, type StorageEntityRef } from './errors.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 操作身份（冻结词汇；Host 传输/能力白名单与公共 Schema 同源同步）
 * ------------------------------------------------------------------ */

export const TASK_VERIFICATION_GET_OPERATION = 'execution.task.verification.get' as const;
export const TASK_APPROVAL_ITEMS_LIST_OPERATION = 'execution.task.approvals.list' as const;
export const TASK_REWORK_CHAIN_LIST_OPERATION = 'execution.task.rework-chain.list' as const;

export const TASK_EVIDENCE_QUERY_OPERATIONS = [
  TASK_VERIFICATION_GET_OPERATION,
  TASK_APPROVAL_ITEMS_LIST_OPERATION,
  TASK_REWORK_CHAIN_LIST_OPERATION,
] as const;

export type TaskEvidenceQueryOperation = (typeof TASK_EVIDENCE_QUERY_OPERATIONS)[number];

/* ------------------------------------------------------------------ *
 * 冻结展示词汇
 * ------------------------------------------------------------------ */

/** 机器结论展示状态（只反映机器检查事实；绝不冒充 Task 有效状态）。 */
export const TASK_MACHINE_STATUSES = [
  'none',
  'running',
  'passed',
  'failed',
  'error',
  'inconclusive',
] as const;
export type TaskMachineStatus = (typeof TASK_MACHINE_STATUSES)[number];

/** 机器结论原因（稳定派生代码；来自持久批次状态，不解析输出文本）。 */
export const TASK_MACHINE_REASONS = [
  'no_verification_batch',
  'batch_running',
  'checks_passed',
  'checks_failed',
  'check_error',
  'checks_inconclusive',
] as const;
export type TaskMachineReason = (typeof TASK_MACHINE_REASONS)[number];

/** 代码资格记账分类（与 task_attempt_reservations.classification 同源）。 */
export const TASK_CODE_ACCOUNTING_CLASSIFICATIONS = ['code', 'infrastructure'] as const;
export type TaskCodeAccountingClassification =
  (typeof TASK_CODE_ACCOUNTING_CLASSIFICATIONS)[number];

/* ------------------------------------------------------------------ *
 * 一致读视图（adapters 层产出；应用层授权完成后消费）
 * ------------------------------------------------------------------ */

/**
 * 单个 Attempt 的代码资格记账事实（来自 task_attempt_reservations 账本）：
 * - classification='infrastructure'（受信 Core 重分类）不消耗代码资格；
 * - outcome/observationDigest 取自最终结算（verification-budget:v1: 前缀），
 *   未结算保持 null——等待人审/尚在执行不是代码额度消耗结论。
 */
export interface TaskAttemptSettlementFacts {
  readonly classification: TaskCodeAccountingClassification;
  readonly outcome: CodeAttemptOutcome | null;
  readonly observationDigest: string | null;
}

/** Task 持久事实行（查询展示所需的最小列；策略副本正文不序列化输出）。 */
export interface TaskEvidenceTaskRow {
  readonly projectId: string;
  readonly taskId: string;
  readonly featureId: string;
  readonly status: TaskStatus;
  readonly executionVersion: number;
  readonly manualBlock: boolean;
  readonly firstPassedAtUtcMs: number | null;
  readonly attemptCounter: number;
  readonly codeAttemptsUsed: number;
  /** Task 策略副本（仅解析 maxCodeAttempts；正文不进入公开形状）。 */
  readonly executionConfig: Readonly<Record<string, unknown>>;
}

/** 机器证据视图：批次（新→旧）+ 逐检查结果 + 各批次 Attempt 的结算事实。 */
export interface TaskVerificationView {
  readonly task: TaskEvidenceTaskRow;
  /** 最新 Attempt（代码现场制品引用 codeRef 展示用；无 Attempt 为 null）。 */
  readonly latestAttempt: AttemptRecord | null;
  /** 有界批次（新→旧，含逐检查结果）；超出上限置 batchesTruncated。 */
  readonly batches: readonly TaskVerificationBatchView[];
  readonly batchesTruncated: boolean;
  /** 批次所属 Attempt 的结算事实（键为 attemptId）。 */
  readonly settlements: Readonly<Record<string, TaskAttemptSettlementFacts>>;
}

export interface TaskVerificationBatchView {
  readonly batch: VerificationBatchRecord;
  readonly checks: readonly CheckResultRecord[];
}

/** 人审事项持久行复用 PlanStore TaskApprovalItemRecord（决定字段服务端决定）。 */
export type TaskApprovalItemRow = TaskApprovalItemRecord;

/** 返工链 Run 事实（暂停原因展示用；未启动/未结束保持 null）。 */
export interface TaskReworkRunRow {
  readonly id: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly status: ExecutionRunStatus;
  readonly reason: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
}

/** 返工链汇总视图：Task 计数 + 最新 Attempt + 所属 Run。 */
export interface TaskReworkView {
  readonly task: TaskEvidenceTaskRow;
  readonly latestAttempt: AttemptRecord | null;
  readonly run: TaskReworkRunRow | null;
}

/** 返工链行：Attempt 事实 + 代码资格记账事实（缺失账本为 null）。 */
export interface TaskReworkAttemptRow {
  readonly attempt: AttemptRecord;
  readonly settlement: TaskAttemptSettlementFacts | null;
}

/**
 * Task 证据/返工链一致读窄端口：只读（无任何写原语）；跨项目/不存在目标
 * 统一 undefined（存在性折叠由应用层统一 not_found）；持久行损坏为
 * StorageError corrupt（fail-closed）。列表沿用既有键集分页与可见范围
 * 谓词下推（visibility 非法形状为可信装配编程错误 TypeError）。
 */
export interface TaskEvidenceQueryReadStore {
  readTaskVerificationView(projectId: unknown, taskId: unknown): TaskVerificationView | undefined;
  /** 人审事项分页：(created_at,id) 复合键升序（与 Attempt 诊断分页同一键集规范）。 */
  listTaskApprovalItemRows(
    visibility: unknown,
    projectId: unknown,
    taskId: unknown,
    request: ExecutionListRequest,
  ): ExecutionRecordPage<TaskApprovalItemRow>;
  readTaskReworkView(projectId: unknown, taskId: unknown): TaskReworkView | undefined;
  listTaskReworkAttemptRows(
    visibility: unknown,
    projectId: unknown,
    taskId: unknown,
    request: ExecutionListRequest,
  ): ExecutionRecordPage<TaskReworkAttemptRow>;
}

/* ------------------------------------------------------------------ *
 * 结算事实解析（持久账本 reason → 结构化事实；损坏 fail-closed）
 * ------------------------------------------------------------------ */

const OPERATION = 'TaskEvidenceQuery.parse';

/**
 * task_attempt_reservations.reason 解析：verification-budget:v1: 前缀行是
 * 最终结算事实；其他非空 reason（如重分类审计）无结算载荷。前缀载荷损坏
 * 一律 StorageError corrupt（查询绝不把损坏账本折算成「未结算」）。
 */
export function parseTaskAttemptSettlementReason(
  reason: string | null,
): { readonly outcome: CodeAttemptOutcome | null; readonly observationDigest: string | null } {
  if (reason === null || !reason.startsWith(CODE_ATTEMPT_SETTLEMENT_PREFIX)) {
    return { outcome: null, observationDigest: null };
  }
  function corrupt(detail: string): never {
    throw new StorageError('corrupt', OPERATION, `代码资格结算账本损坏（${detail}）`, {
      entity: { type: 'task_attempt_reservation' },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reason.slice(CODE_ATTEMPT_SETTLEMENT_PREFIX.length));
  } catch {
    corrupt('非法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    corrupt('载荷不是对象');
  }
  const object = parsed as Record<string, unknown>;
  const outcome = object.outcome;
  const observationDigest = object.observationDigest;
  if (
    (outcome !== 'passed' && outcome !== 'code_failure' && outcome !== 'non_code_failure') ||
    typeof observationDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(observationDigest)
  ) {
    corrupt('载荷字段形态非法');
  }
  return { outcome, observationDigest };
}

/* ------------------------------------------------------------------ *
 * 公开形状（稳定 Schema；Host 公共面按这些冻结字段集做线校验）
 * ------------------------------------------------------------------ */

/** 有效 Task 展示状态：machine passed 绝不折算为有效 Task passed。 */
export interface PublicTaskEvidenceState {
  readonly taskId: string;
  readonly featureId: string;
  readonly status: TaskStatus;
  readonly executionVersion: number;
  readonly manualBlock: boolean;
  /** 首次受信通过时间；未通过为 null。 */
  readonly firstPassedAt: string | null;
  /** 有效 Task 通过（恒等于 status === 'passed'；机器绿色不等于此值为 true）。 */
  readonly effectivePassed: boolean;
}

/** Task 当前机器结论（只反映持久机器事实；人审状态不在本节混入）。 */
export interface PublicTaskMachineConclusion {
  readonly status: TaskMachineStatus;
  readonly outcome: CodeAttemptOutcome | null;
  readonly reason: TaskMachineReason;
  readonly attemptId: string | null;
  readonly batchId: string | null;
  readonly codeDigest: string | null;
  readonly policyDigest: string | null;
  readonly codeRef: string | null;
  readonly observationDigest: string | null;
}

/** 选择/回退理由快照（候选选择或安全全量回退的持久理由）。 */
export const TASK_VERIFICATION_SELECTION_MODES = ['candidates', 'full_fallback'] as const;
export type TaskVerificationSelectionMode = (typeof TASK_VERIFICATION_SELECTION_MODES)[number];

export interface PublicVerificationSelection {
  readonly mode: TaskVerificationSelectionMode;
  readonly reason: string;
  readonly selectedCheckKeys: readonly string[];
}

/** 逐检查结果（输出 Artifact/tail 引用；未知指标保持 null）。 */
export interface PublicVerificationCheckResult {
  readonly id: string;
  readonly checkKey: string;
  readonly argv: readonly string[];
  readonly cwdRef: string | null;
  readonly environmentRef: string | null;
  readonly timeoutMs: number;
  readonly required: boolean;
  readonly status: CheckResultStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputArtifactId: string | null;
  readonly outputDigest: string | null;
  readonly outputTail: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

/** VerificationBatch（代码/策略/环境身份 + 选择理由 + 逐检查结果）。 */
export interface PublicVerificationBatchRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
  readonly operation: string;
  readonly codeDigest: string;
  readonly policyDigest: string;
  readonly environmentSummary: Readonly<Record<string, unknown>>;
  readonly selection: PublicVerificationSelection;
  readonly status: VerificationBatchStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly checks: readonly PublicVerificationCheckResult[];
}

/** execution.task.verification.get 结果。 */
export interface TaskVerificationDetailResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'task-verification';
  readonly task: PublicTaskEvidenceState;
  readonly machine: PublicTaskMachineConclusion;
  readonly batches: readonly PublicVerificationBatchRecord[];
  readonly batchesTruncated: boolean;
}

/** 独立人审事项（责任主体 + 绑定摘要 + 决定；与机器证据分开展示）。 */
export interface PublicTaskApprovalArtifactRef {
  readonly artifactId: string;
  readonly contentHash: string | null;
}

export interface PublicTaskApprovalItemRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly kind: 'block' | 'approval';
  readonly description: string;
  readonly responsibleParty: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'unblocked';
  readonly planDigest: string;
  readonly codeDigest: string | null;
  readonly artifactRefs: readonly PublicTaskApprovalArtifactRef[];
  readonly createdBy: string;
  readonly decision: 'approve' | 'reject' | 'unblock' | null;
  readonly decisionActor: string | null;
  readonly decisionReason: string | null;
  readonly decisionCodeDigest: string | null;
  readonly decisionArtifactRefs: readonly PublicTaskApprovalArtifactRef[];
  readonly decidedAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** execution.task.approvals.list 结果（有界 (created_at,id) 键集分页）。 */
export interface TaskApprovalItemListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'task-approval-item-list';
  readonly records: readonly PublicTaskApprovalItemRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

/** 代码资格记账（每 Attempt；不把基础设施错误显示为代码额度消耗）。 */
export interface PublicReworkCodeAccounting {
  readonly classification: TaskCodeAccountingClassification | null;
  readonly outcome: CodeAttemptOutcome | null;
  readonly observationDigest: string | null;
  readonly countsAsCodeAttempt: boolean;
}

/** 返工链 Attempt 行（历次 Attempt + 失败引用；未知退出/耗时保持 null）。 */
export interface PublicReworkAttemptRecord {
  readonly id: string;
  readonly number: number;
  readonly runId: string;
  readonly status: AttemptStatus;
  readonly executionStage: AttemptExecutionStage;
  readonly executionVersion: number;
  readonly inputRef: string;
  readonly codeRef: string | null;
  readonly diagnosticRef: string | null;
  readonly errorKind: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly codeAccounting: PublicReworkCodeAccounting;
}

/** 代码资格（含首次；上限来自 Task 策略副本，缺省含首次共三次）。 */
export interface PublicReworkCodeEligibility {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly rule: TaskAttemptCaps['rule'];
}

/** Run 暂停/状态原因（持久控制原因原样展示）。 */
export interface PublicReworkRunView {
  readonly id: string;
  readonly batchId: string;
  readonly status: ExecutionRunStatus;
  readonly reason: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

/** 后继 Task 阻断展示（与 evaluateTaskDag 同源派生；不落第二套状态）。 */
export interface PublicReworkSuccessorView {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly reason: TaskDagReason;
}

export interface PublicReworkChainSummary {
  readonly codeEligibility: PublicReworkCodeEligibility;
  readonly attempts: {
    readonly used: number;
    readonly limit: number | null;
    readonly remaining: number | null;
  };
  readonly run: PublicReworkRunView | null;
  readonly budgetBlockReasons: readonly PublicExecutionBudgetBlockReason[];
  readonly blockedSuccessors: readonly PublicReworkSuccessorView[];
}

/** execution.task.rework-chain.list 结果（有界复合键分页 + 汇总）。 */
export interface TaskReworkChainListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'task-rework-chain';
  readonly records: readonly PublicReworkAttemptRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly summary: PublicReworkChainSummary;
}

/* ------------------------------------------------------------------ *
 * 纯投影（确定性；不读时钟、不产生写入）
 * ------------------------------------------------------------------ */

function isoOr(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function toPublicTaskEvidenceState(row: TaskEvidenceTaskRow): PublicTaskEvidenceState {
  return {
    taskId: row.taskId,
    featureId: row.featureId,
    status: row.status,
    executionVersion: row.executionVersion,
    manualBlock: row.manualBlock,
    firstPassedAt: isoOr(row.firstPassedAtUtcMs),
    effectivePassed: row.status === 'passed',
  };
}

/**
 * 机器结论派生：只取持久批次/结算事实。
 * - 无批次 → none/no_verification_batch；
 * - 最新批次未定版 → running/batch_running（含仍在收集证据的批次）；
 * - 定版批次 → 批次状态直接映射为机器结论，outcome 取该批次 Attempt 的
 *   持久结算（缺失为 null，不推断）。
 */
export function deriveTaskMachineConclusion(view: TaskVerificationView): PublicTaskMachineConclusion {
  const latest = view.batches[0];
  const base = {
    outcome: null,
    attemptId: null,
    batchId: null,
    codeDigest: null,
    policyDigest: null,
    codeRef: view.latestAttempt?.codeRef ?? null,
    observationDigest: null,
  };
  if (latest === undefined) {
    return { status: 'none', reason: 'no_verification_batch', ...base };
  }
  const settlement = view.settlements[latest.batch.attemptId] ?? null;
  const common = {
    attemptId: latest.batch.attemptId,
    batchId: latest.batch.id,
    codeDigest: latest.batch.codeDigest,
    policyDigest: latest.batch.policyDigest,
    codeRef: view.latestAttempt?.codeRef ?? null,
    observationDigest: settlement?.observationDigest ?? null,
  };
  if (latest.batch.status === 'running') {
    return { status: 'running', reason: 'batch_running', outcome: null, ...common };
  }
  const mapped: Record<'passed' | 'failed' | 'error' | 'inconclusive', TaskMachineStatus> = {
    passed: 'passed',
    failed: 'failed',
    error: 'error',
    inconclusive: 'inconclusive',
  };
  const reasons: Record<'passed' | 'failed' | 'error' | 'inconclusive', TaskMachineReason> = {
    passed: 'checks_passed',
    failed: 'checks_failed',
    error: 'check_error',
    inconclusive: 'checks_inconclusive',
  };
  return {
    status: mapped[latest.batch.status],
    reason: reasons[latest.batch.status],
    outcome: settlement?.outcome ?? null,
    ...common,
  };
}

export function toPublicVerificationSelection(
  selection: VerificationSelectionSnapshot,
): PublicVerificationSelection {
  return {
    mode: selection.mode,
    reason: selection.reason,
    selectedCheckKeys: [...selection.selectedCheckKeys],
  };
}

export function toPublicVerificationCheckResult(check: CheckResultRecord): PublicVerificationCheckResult {
  return {
    id: check.id,
    checkKey: check.checkKey,
    argv: [...check.argv],
    cwdRef: check.cwdRef,
    environmentRef: check.environmentRef,
    timeoutMs: check.timeoutMs,
    required: check.required,
    status: check.status,
    exitCode: check.exitCode,
    signal: check.signal,
    timedOut: check.timedOut,
    outputArtifactId: check.outputArtifactId,
    outputDigest: check.outputDigest,
    outputTail: check.outputTail,
    startedAt: isoOr(check.startedAtUtcMs),
    endedAt: isoOr(check.endedAtUtcMs),
  };
}

export function toPublicVerificationBatchRecord(
  entry: TaskVerificationBatchView,
): PublicVerificationBatchRecord {
  return {
    id: entry.batch.id,
    projectId: entry.batch.projectId,
    featureId: entry.batch.featureId,
    runId: entry.batch.runId,
    taskId: entry.batch.taskId,
    attemptId: entry.batch.attemptId,
    executionVersion: entry.batch.executionVersion,
    operation: entry.batch.operation,
    codeDigest: entry.batch.codeDigest,
    policyDigest: entry.batch.policyDigest,
    environmentSummary: { ...entry.batch.environmentSummary },
    selection: toPublicVerificationSelection(entry.batch.selection),
    status: entry.batch.status,
    startedAt: isoOr(entry.batch.startedAtUtcMs),
    endedAt: isoOr(entry.batch.endedAtUtcMs),
    checks: entry.checks.map(toPublicVerificationCheckResult),
  };
}

export function toPublicTaskApprovalItemRecord(row: TaskApprovalItemRow): PublicTaskApprovalItemRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    featureId: row.featureId,
    taskId: row.taskId,
    kind: row.kind,
    description: row.description,
    responsibleParty: row.responsibleParty,
    status: row.status,
    planDigest: row.planDigest,
    codeDigest: row.codeDigest,
    artifactRefs: row.artifactRefs.map((ref) => ({
      artifactId: ref.artifactId,
      contentHash: ref.contentHash,
    })),
    createdBy: row.createdBy,
    decision: row.decision,
    decisionActor: row.decisionActor,
    decisionReason: row.decisionReason,
    decisionCodeDigest: row.decisionCodeDigest,
    decisionArtifactRefs: row.decisionArtifactRefs.map((ref) => ({
      artifactId: ref.artifactId,
      contentHash: ref.contentHash,
    })),
    decidedAt: isoOr(row.decidedAtUtcMs),
    revision: row.revision,
    createdAt: isoOr(row.createdAtUtcMs)!,
    updatedAt: isoOr(row.updatedAtUtcMs)!,
  };
}

export function toPublicReworkCodeAccounting(
  settlement: TaskAttemptSettlementFacts | null,
): PublicReworkCodeAccounting {
  return {
    classification: settlement?.classification ?? null,
    outcome: settlement?.outcome ?? null,
    observationDigest: settlement?.observationDigest ?? null,
    countsAsCodeAttempt: settlement?.classification === 'code',
  };
}

export function toPublicReworkAttemptRecord(row: TaskReworkAttemptRow): PublicReworkAttemptRecord {
  const attempt = row.attempt;
  return {
    id: attempt.id,
    number: attempt.number,
    runId: attempt.runId,
    status: attempt.status,
    executionStage: attempt.executionStage,
    executionVersion: attempt.executionVersion,
    inputRef: attempt.inputRef,
    codeRef: attempt.codeRef,
    diagnosticRef: attempt.diagnosticRef,
    errorKind: attempt.errorKind,
    startedAt: isoOr(attempt.startedAtUtcMs),
    endedAt: isoOr(attempt.endedAtUtcMs),
    durationMs: attempt.durationMs,
    exitCode: attempt.exitCode,
    codeAccounting: toPublicReworkCodeAccounting(row.settlement),
  };
}

/**
 * 代码资格：已用取持久计数 codeAttemptsUsed（基础设施重分类可退还、等待
 * 人审不创建编码 Attempt），上限取 Task 策略副本 maxCodeAttempts（缺省含
 * 首次共三次；与 submitVerification 耗尽判定同一规则），不把 Attempt 行数
 * 折算成代码消耗。
 */
export function buildReworkCodeEligibility(row: TaskEvidenceTaskRow): PublicReworkCodeEligibility {
  const context: ValidationContext = {
    operation: 'TaskEvidenceQuery.codeEligibility',
    entity: { type: 'task', projectId: row.projectId, id: row.taskId },
  };
  const raw: unknown = row.executionConfig.maxCodeAttempts;
  const caps = resolveTaskAttemptCaps(
    {
      ...(raw === undefined || raw === null ? {} : { maxCodeAttempts: raw }),
      maxAttemptsPerTask: null,
    },
    context,
  );
  const decision = evaluateTaskCodeAttemptReservation(caps, row.codeAttemptsUsed);
  return {
    used: decision.used,
    limit: decision.limit,
    remaining: decision.remaining,
    rule: caps.rule,
  };
}

export function toPublicReworkRunView(run: TaskReworkRunRow): PublicReworkRunView {
  return {
    id: run.id,
    batchId: run.batchId,
    status: run.status,
    reason: run.reason,
    startedAt: isoOr(run.startedAtUtcMs),
    endedAt: isoOr(run.endedAtUtcMs),
  };
}

/** 汇总中的总 Attempt 计数（未配置上限保持 null，不虚构额度）。 */
export function buildReworkAttemptTotals(row: TaskEvidenceTaskRow): PublicReworkChainSummary['attempts'] {
  const context: ValidationContext = {
    operation: 'TaskEvidenceQuery.attemptTotals',
    entity: { type: 'task', projectId: row.projectId, id: row.taskId },
  };
  const raw: unknown = row.executionConfig.maxAttemptsPerTask;
  const caps = resolveTaskAttemptCaps(
    {
      maxCodeAttempts: null,
      ...(raw === undefined || raw === null ? {} : { maxAttemptsPerTask: raw }),
    },
    context,
  );
  const limit = caps.maxAttemptsPerTask;
  return {
    used: row.attemptCounter,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - row.attemptCounter),
  };
}

/* ------------------------------------------------------------------ *
 * 校验（读取视图形状检查；损坏持久行 fail-closed）
 * ------------------------------------------------------------------ */

const SETTLEMENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function validateTaskAttemptSettlementFacts(
  value: unknown,
  entity: StorageEntityRef,
): TaskAttemptSettlementFacts {
  function corrupt(detail: string): never {
    throw new StorageError('corrupt', `${OPERATION}.validate`, `代码资格记账事实损坏（${detail}）`, { entity });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) corrupt('不是对象');
  const object = value as Record<string, unknown>;
  if (
    object.classification !== 'code' &&
    object.classification !== 'infrastructure'
  ) {
    corrupt('classification 非法');
  }
  const outcome = object.outcome;
  if (outcome !== null && outcome !== 'passed' && outcome !== 'code_failure' && outcome !== 'non_code_failure') {
    corrupt('outcome 非法');
  }
  const digest = object.observationDigest;
  if (digest !== null && (typeof digest !== 'string' || !SETTLEMENT_DIGEST_PATTERN.test(digest))) {
    corrupt('observationDigest 非法');
  }
  return {
    classification: object.classification,
    outcome,
    observationDigest: digest,
  };
}
