/**
 * P05-1 / F-011 规划上下文与候选的只读授权查询契约（ports 纯契约层）。
 *
 * 设计依据：input/p05-planning.md FR-4（查询关联 Project/Phase/Feature/Batch/
 * Run/planning Task/Attempt、候选 Artifact 与 candidateDigest、拒绝原因、应用
 * 映射与预算/停止阻塞原因；生成前 candidateId 明确为待生成）、core-design/04
 * §3/§6（SQLite 是调度真相、原因可查询；planning Run 成功 ≠ 计划批准 ≠
 * 编码可执行）、docs/p03-1-plan-import-contract.md §6.6（同一分页/游标/只读
 * 纪律）与 docs/p05-1-planning-candidate-contract.md（单候选、历史保留、
 * 拒绝不倒改）。
 *
 * 不变量：
 * - 全部内容取自持久 SQLite 的单一一致读视图（PlanningQueryReadStore，适配器
 *   以 BEGIN DEFERRED 读事务实现）；查询面零写入、零事件、零唤醒、零恢复、
 *   零导入——不触发模型、不推进状态机、不改写候选或决策事实；
 * - 公开形状只暴露身份/状态/摘要/计数/时间/受控引用等结构化事实：绝不携带
 *   数据库路径、凭据引用或原始私有策略正文（规划用途策略副本只展示路由
 *   runtime/provider/model，credentialRef/endpointRef 不进入公开面）；
 * - 生成前的候选明确为 pending_generation（candidateId 身份已绑定但 Artifact
 *   尚未发布），不返回伪造空候选；发布后的候选正文只经既有受管 Artifact
 *   完整性核验读取（hash/size 复核），缺失/损坏 fail-closed 为 corrupt_state；
 * - 展示分类（derivePlanningQueryState）在一致读边界上区分 queued/running/
 *   待审批/拒绝/已应用/失败/取消/待恢复；planning Run 成功、计划批准与编码
 *   可执行三条轴独立展示（PlanningOutcomeAxes），不互相冒充；
 * - 列表复用计划分页同一规范：limit 默认 50 / 上限 200、plcur_v1_ 受控游标
 *   （绑定数据根 + 项目 [+ Feature 过滤]，跨项目/跨过滤/跨根重放一律
 *   invalid_cursor）；稳定 id 升序键集分页；
 * - 复用既有预算投影（ExecutionBudgetStatusResult）与不可执行原因推导
 *   （deriveFeatureNotExecutableReasons），不创建与业务状态冲突的第二套事实；
 *   规划历史（planning Task）不计入业务 Task 列表或完成数量；
 * - 跨项目/不存在目标统一 undefined（应用层折叠为 not_found，不泄漏存在性）；
 *   visibility 非法形状为可信装配编程错误（TypeError）。
 *
 * 本契约不实现：P05-9 的全 Batch 收尾与操作查询、Host/CLI 传输接线、任何
 * 写路径或恢复编排。
 */
import { PublicError, WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import type {
  PlanningContextDecision,
  PlanningContextRecord,
  PlanningContextStatus,
} from './planning-context.js';
import { PLANNING_RUN_PURPOSE } from './planning-candidates.js';
import type { ExecutionBatchStatus, ExecutionRunStatus } from './execution-store.js';
import type { AttemptExecutionStage, AttemptStatus } from './attempt-store.js';
import type { FeaturePlanStatus } from './plan-store.js';
import type {
  FeatureNotExecutableReason,
  PlanListRequest,
  PlanRecordPage,
} from './queries.js';
import { deriveFeatureNotExecutableReasons } from './queries.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateStableId,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 查询操作身份（PublicError.operation 与后续 Host 路由共用）
 * ------------------------------------------------------------------ */

export const PLANNING_CONTEXTS_LIST_OPERATION = 'planning.contexts.list' as const;
export const PLANNING_CONTEXT_GET_OPERATION = 'planning.context.get' as const;
export const PLANNING_CANDIDATE_GET_OPERATION = 'planning.candidate.get' as const;

export const PLANNING_QUERY_OPERATIONS = [
  PLANNING_CONTEXTS_LIST_OPERATION,
  PLANNING_CONTEXT_GET_OPERATION,
  PLANNING_CANDIDATE_GET_OPERATION,
] as const;

export type PlanningQueryOperation = (typeof PLANNING_QUERY_OPERATIONS)[number];

/* ------------------------------------------------------------------ *
 * 有界常量
 * ------------------------------------------------------------------ */

/** 详情视图关联 Attempt 的单次读取上限（超出置 attemptsTruncated）。 */
export const PLANNING_QUERY_DETAIL_ATTEMPTS_MAX_COUNT = 20;

/**
 * 候选正文读取缓冲上限：与 F-006 受限提交入口的同一常量（同一候选正文在
 * 写入与读取两侧共用同一界，不各自另立数值）。
 */
export const PLANNING_CANDIDATE_BODY_MAX_READ_BYTES = 1_048_576;

/* ------------------------------------------------------------------ *
 * 展示状态（冻结词汇；一致读边界上的纯派生，不落库）
 * ------------------------------------------------------------------ */

/**
 * 规划查询展示分类（派生事实，绝不写回 planning_contexts）：
 * - queued / running：规划 Run 未结束（queued / running / pausing /
 *   cancelling 原样归入运行中，run.status 另行原样展示）；
 * - awaiting_approval：候选已发布且规划 Run 成功结束，等待人工决策；
 * - rejected / applied / cancelled：人工决策或取消结算终态；
 * - failed：规划 Run 失败结束（含 Run 成功但候选从未发布——无可审批候选）；
 * - pending_recovery：Run paused/interrupted 或存在非终态 interrupted Attempt
 *   （停止不确定/待恢复事实，不冒充运行中或已失败）。
 */
export const PLANNING_QUERY_STATES = [
  'queued',
  'running',
  'awaiting_approval',
  'rejected',
  'applied',
  'failed',
  'cancelled',
  'pending_recovery',
] as const;
export type PlanningQueryState = (typeof PLANNING_QUERY_STATES)[number];

/** 候选生成状态：pending_generation（身份已绑定、Artifact 未发布）/ published。 */
export const PLANNING_CANDIDATE_QUERY_STATES = ['pending_generation', 'published'] as const;
export type PlanningCandidateQueryState = (typeof PLANNING_CANDIDATE_QUERY_STATES)[number];

/** derivePlanningQueryState 输入（一致读视图内的持久事实；无缺省猜测）。 */
export interface PlanningQueryStateInput {
  readonly contextStatus: PlanningContextStatus;
  readonly runStatus: ExecutionRunStatus;
  /** 最新 Attempt 状态（无 Attempt 为 null）。 */
  readonly latestAttemptStatus: AttemptStatus | null;
}

/**
 * 一致读边界上的展示分类（纯函数；优先级：上下文终态 → 取消/失败 → 待恢复 →
 * 候选待审批 → Run 运行状态）。Run 成功而候选未发布归入 failed：planning Run
 * 成功本身由 PlanningOutcomeAxes.runSucceeded 独立展示，不与候选可审批混淆。
 */
export function derivePlanningQueryState(input: PlanningQueryStateInput): PlanningQueryState {
  if (input.contextStatus === 'applied') return 'applied';
  if (input.contextStatus === 'rejected') return 'rejected';
  if (input.contextStatus === 'cancelled') return 'cancelled';
  if (input.runStatus === 'cancelled') return 'cancelled';
  if (input.runStatus === 'failed') return 'failed';
  if (input.runStatus === 'paused' || input.runStatus === 'interrupted') return 'pending_recovery';
  if (input.latestAttemptStatus === 'interrupted') return 'pending_recovery';
  if (input.runStatus === 'succeeded') {
    return input.contextStatus === 'candidate_published' ? 'awaiting_approval' : 'failed';
  }
  return input.runStatus === 'queued' ? 'queued' : 'running';
}

/**
 * 三条独立结果轴（绝不互相冒充）：
 * - runSucceeded：planning Run 以 succeeded 终态结束（执行成功）；
 * - planApproved：Feature 当前 planStatus=approved（业务计划已批准；批准可
 *   来自候选应用或既有导入审批，由 planStatus 权威表达）；
 * - codingExecutable：计划批准且存在 coding Task（复用 F-006 不可执行原因
 *   词汇；planning Task 不计入 codingTaskCount）。
 */
export interface PlanningOutcomeAxes {
  readonly runSucceeded: boolean;
  readonly planApproved: boolean;
  readonly codingExecutable: boolean;
  readonly notExecutableReasons: readonly FeatureNotExecutableReason[];
}

/** 由一致读视图事实派生三条结果轴（纯函数）。 */
export function derivePlanningOutcomeAxes(input: {
  readonly runStatus: ExecutionRunStatus;
  readonly featurePlanStatus: FeaturePlanStatus;
  readonly codingTaskCount: number;
}): PlanningOutcomeAxes {
  const notExecutableReasons = deriveFeatureNotExecutableReasons({
    taskCount: input.codingTaskCount,
    planStatus: input.featurePlanStatus,
  });
  return {
    runSucceeded: input.runStatus === 'succeeded',
    planApproved: input.featurePlanStatus === 'approved',
    codingExecutable: notExecutableReasons.length === 0,
    notExecutableReasons,
  };
}

/* ------------------------------------------------------------------ *
 * 一致读视图事实（adapters 层实现；应用层授权完成后调用）
 * ------------------------------------------------------------------ */

/** 规划 Run 控制事实（停止/阻塞原因原样保留；未知时间保持 null）。 */
export interface PlanningQueryRunFacts {
  readonly id: string;
  readonly batchId: string;
  readonly labels: readonly string[];
  readonly purpose: typeof PLANNING_RUN_PURPOSE;
  readonly status: ExecutionRunStatus;
  readonly reason: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
  readonly pauseRequestedAtUtcMs: number | null;
  readonly attemptsCreated: number;
  readonly maxAttemptsPerRun: number;
  readonly runTimeLimitMs: number;
}

/** 规划 Run 关联 Attempt 摘要事实（未知退出/耗时保持 null）。 */
export interface PlanningQueryAttemptFacts {
  readonly id: string;
  readonly number: number;
  readonly status: AttemptStatus;
  readonly executionStage: AttemptExecutionStage;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

/** Feature 当前身份事实（计划批准轴与编码可执行轴的权威来源）。 */
export interface PlanningQueryFeatureFacts {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly planStatus: FeaturePlanStatus;
  readonly planDigest: string | null;
  /** 业务编码 Task 计数（kind='coding'；planning Task 不计入）。 */
  readonly codingTaskCount: number;
}

/**
 * 规划上下文查询一致读视图：上下文 + 绑定 planning Task 快照（在
 * PlanningContextRecord 内）+ Run 控制事实 + 有界 Attempt 摘要 + Feature
 * 当前身份，全部在单一 DEFERRED 读事务内取得；并发决策/应用/取消只能观察到
 * 完整前后状态。
 */
export interface PlanningContextQueryView {
  readonly context: PlanningContextRecord;
  readonly run: PlanningQueryRunFacts;
  readonly attempts: readonly PlanningQueryAttemptFacts[];
  readonly attemptsTruncated: boolean;
  readonly feature: PlanningQueryFeatureFacts;
}

/** 列表行：上下文记录 + Run 状态摘要（同一读事务内 JOIN 解析）。 */
export interface PlanningContextListRow {
  readonly context: PlanningContextRecord;
  readonly runStatus: ExecutionRunStatus | null;
  readonly runEndedAtUtcMs: number | null;
}

/**
 * 规划查询窄读取端口：只读（无任何写原语）；跨项目/不存在目标统一
 * undefined（可见性与存在性折叠由应用层统一为 not_found）；列表沿用计划分页
 * 的可见范围谓词与键集分页形态（featureId 为 null 表示项目范围列表）。
 */
export interface PlanningQueryReadStore {
  readPlanningContextView(
    projectId: unknown,
    candidateId: unknown,
  ): PlanningContextQueryView | undefined;
  listPlanningContextRecords(
    visibility: unknown,
    projectId: unknown,
    featureId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<PlanningContextListRow>;
}

/* ------------------------------------------------------------------ *
 * 公开记录形状与纯投影（时间 ISO UTC；确定性，不读时钟）
 * ------------------------------------------------------------------ */

/** 候选公开引用：生成前明确 pending_generation，不伪造摘要/正文。 */
export type PublicPlanningCandidateRef =
  | { readonly state: 'pending_generation' }
  | {
      readonly state: 'published';
      readonly artifactId: string;
      readonly contentHash: string;
      readonly candidateDigest: string;
      readonly summary: string;
    };

/** 人工决策公开投影（拒绝原因/应用映射原样保留；未知时间保持 null）。 */
export interface PublicPlanningDecision {
  readonly decision: PlanningContextDecision;
  readonly reason: string | null;
  readonly decidedAt: string | null;
  readonly appliedRevision: number | null;
  readonly appliedAt: string | null;
}

/** 绑定 planning Task 公开摘要（只含身份/状态/非秘密路由摘要）。 */
export interface PublicPlanningTaskSummary {
  readonly id: string;
  readonly status: string;
  /** 冻结策略副本的非秘密路由摘要（不含 credentialRef/endpointRef）。 */
  readonly strategy: { readonly runtime: string; readonly provider: string; readonly model: string };
}

function isoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** 规划上下文公开记录（与 PlanningContextRecord 身份/状态/决策一一对应）。 */
export interface PublicPlanningContextRecord {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
  readonly inputDigest: string;
  readonly targetRevision: number;
  readonly planDigest: string | null;
  readonly status: PlanningContextStatus;
  readonly candidate: PublicPlanningCandidateRef;
  readonly decision: PublicPlanningDecision | null;
  readonly planningTask: PublicPlanningTaskSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicPlanningContextRecord(
  record: PlanningContextRecord,
): PublicPlanningContextRecord {
  const candidate: PublicPlanningCandidateRef =
    record.candidateArtifactRef === null || record.candidateDigest === null
      ? { state: 'pending_generation' }
      : {
          state: 'published',
          artifactId: record.candidateArtifactRef.artifactId,
          contentHash: record.candidateArtifactRef.contentHash,
          candidateDigest: record.candidateDigest,
          summary: record.candidateSummary ?? '',
        };
  return {
    id: record.id,
    projectId: record.projectId,
    phaseId: record.phaseId,
    featureId: record.featureId,
    runId: record.runId,
    planningTaskId: record.planningTaskId,
    candidateId: record.candidateId,
    inputDigest: record.inputDigest,
    targetRevision: record.targetRevision,
    planDigest: record.planDigest,
    status: record.status,
    candidate,
    decision:
      record.decision === null
        ? null
        : {
            decision: record.decision,
            reason: record.decisionReason,
            decidedAt: isoOrNull(record.decidedAtUtcMs),
            appliedRevision: record.appliedRevision,
            appliedAt: isoOrNull(record.appliedAtUtcMs),
          },
    planningTask: {
      id: record.planningTask.id,
      status: record.planningTask.status,
      strategy: {
        runtime: record.planningTask.executionConfig.runtime,
        provider: record.planningTask.executionConfig.provider,
        model: record.planningTask.executionConfig.model,
      },
    },
    createdAt: new Date(record.createdAtUtcMs).toISOString(),
    updatedAt: new Date(record.updatedAtUtcMs).toISOString(),
  };
}

/** 规划 Run 公开投影（停止/阻塞原因原样；时间 ISO UTC）。 */
export interface PublicPlanningRunRecord {
  readonly id: string;
  readonly batchId: string;
  readonly labels: readonly string[];
  readonly purpose: typeof PLANNING_RUN_PURPOSE;
  readonly status: ExecutionRunStatus;
  readonly reason: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly pauseRequestedAt: string | null;
  readonly attemptsCreated: number;
  readonly maxAttemptsPerRun: number;
  readonly runTimeLimitMs: number;
}

export function toPublicPlanningRunRecord(facts: PlanningQueryRunFacts): PublicPlanningRunRecord {
  return {
    id: facts.id,
    batchId: facts.batchId,
    labels: [...facts.labels],
    purpose: facts.purpose,
    status: facts.status,
    reason: facts.reason,
    startedAt: isoOrNull(facts.startedAtUtcMs),
    endedAt: isoOrNull(facts.endedAtUtcMs),
    pauseRequestedAt: isoOrNull(facts.pauseRequestedAtUtcMs),
    attemptsCreated: facts.attemptsCreated,
    maxAttemptsPerRun: facts.maxAttemptsPerRun,
    runTimeLimitMs: facts.runTimeLimitMs,
  };
}

/** 规划 Attempt 公开投影（未知退出/耗时保持 null）。 */
export interface PublicPlanningAttemptRecord {
  readonly id: string;
  readonly number: number;
  readonly status: AttemptStatus;
  readonly executionStage: AttemptExecutionStage;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

export function toPublicPlanningAttemptRecord(
  facts: PlanningQueryAttemptFacts,
): PublicPlanningAttemptRecord {
  return {
    id: facts.id,
    number: facts.number,
    status: facts.status,
    executionStage: facts.executionStage,
    startedAt: isoOrNull(facts.startedAtUtcMs),
    endedAt: isoOrNull(facts.endedAtUtcMs),
    exitCode: facts.exitCode,
    durationMs: facts.durationMs,
  };
}

/** 列表摘要行（上下文状态与 Run 状态并列展示，不互相推导覆盖）。 */
export interface PublicPlanningContextSummary {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly planningTaskId: string;
  readonly candidateId: string;
  readonly status: PlanningContextStatus;
  readonly candidateState: PlanningCandidateQueryState;
  readonly candidateDigest: string | null;
  readonly decision: PlanningContextDecision | null;
  readonly runStatus: ExecutionRunStatus | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicPlanningContextSummary(
  row: PlanningContextListRow,
): PublicPlanningContextSummary {
  return {
    id: row.context.id,
    projectId: row.context.projectId,
    phaseId: row.context.phaseId,
    featureId: row.context.featureId,
    runId: row.context.runId,
    planningTaskId: row.context.planningTaskId,
    candidateId: row.context.candidateId,
    status: row.context.status,
    candidateState: row.context.candidateArtifactRef === null ? 'pending_generation' : 'published',
    candidateDigest: row.context.candidateDigest,
    decision: row.context.decision,
    runStatus: row.runStatus,
    createdAt: new Date(row.context.createdAtUtcMs).toISOString(),
    updatedAt: new Date(row.context.updatedAtUtcMs).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 查询结果形状（字段集冻结）
 * ------------------------------------------------------------------ */

/** planning.contexts.list → {schemaVersion, scope, records, nextCursor, limit}。 */
export interface PlanningContextListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'planning-context-list';
  readonly records: readonly PublicPlanningContextSummary[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

/**
 * planning.context.get → {context, executionState, outcomeAxes, run, attempts,
 * attemptsTruncated, budget}：全部身份/状态/决策/应用映射/预算阻塞事实来自
 * 同一一致读视图（预算投影取自既有 execution.budget.get 纯投影，Task 面过滤
 * 为 planning Task）；查询零写入、零事件、零唤醒。
 */
export interface PlanningContextDetailResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'planning-context';
  readonly context: PublicPlanningContextRecord;
  readonly executionState: PlanningQueryState;
  readonly outcomeAxes: PlanningOutcomeAxes;
  readonly run: PublicPlanningRunRecord;
  readonly attempts: readonly PublicPlanningAttemptRecord[];
  readonly attemptsTruncated: boolean;
  /** 复用既有预算投影（batch/run/task 面与阻塞原因；只读派生）。 */
  readonly budget: import('./execution-budget-query.js').ExecutionBudgetStatusResult;
}

/** 已核验候选正文的结构化公开投影（plan/verification/摘要；不含执行语义）。 */
export interface PublicPlanningCandidateBody {
  readonly state: 'published';
  readonly artifact: {
    readonly artifactId: string;
    readonly contentHash: string;
    readonly sizeBytes: number;
  };
  readonly candidateDigest: string;
  readonly summary: string;
  readonly plan: {
    readonly feature: {
      readonly title: string;
      readonly description: string | null;
      readonly labels: readonly string[];
    };
    readonly tasks: readonly {
      readonly id: string;
      readonly title: string;
      readonly complexity: import('./feature-plan.js').PlanComplexity | null;
      readonly dependsOn: readonly string[];
    }[];
    readonly taskCount: number;
    readonly dependencyEdgeCount: number;
  };
  readonly taskVerification: readonly {
    readonly taskId: string;
    readonly checkRefs: readonly string[];
    readonly moduleRefs: readonly string[];
    readonly impactScope: readonly string[];
  }[];
}

/**
 * planning.candidate.get → {context, runStatus, candidate}：生成前 candidate
 * 明确为 pending_generation（不伪造空候选）；发布后正文经受管 Artifact 完整
 * 性核验 + 候选契约校验 + 身份/摘要交叉核对，任一失败 corrupt_state。
 */
export interface PlanningCandidateDetailResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'planning-candidate';
  readonly context: PublicPlanningContextRecord;
  readonly runStatus: ExecutionRunStatus;
  readonly candidate: { readonly state: 'pending_generation' } | PublicPlanningCandidateBody;
}

/* ------------------------------------------------------------------ *
 * 输入校验（unknown → 已校验形态；未知键一律拒绝）
 * ------------------------------------------------------------------ */

export interface ValidatedPlanningContextsListTarget {
  readonly projectId: string;
  /** null = 项目范围列表；非 null = Feature 过滤（游标绑定同一过滤）。 */
  readonly featureId: string | null;
}

/**
 * planning.contexts.list 目标校验（字段集冻结：projectId/featureId/limit/
 * cursor 之外未知键——含提权字段 actorId/principal/capabilities/scope——
 * 在任何授权判定与 SQL 之前拒绝）；limit/cursor 的分页校验在项目可见性
 * 核验之后由 validatePlanListFilter 完成（不可见项目先 forbidden）。
 */
export function validatePlanningContextsListTarget(
  value: unknown,
  operation: string,
): ValidatedPlanningContextsListTarget {
  const context: ValidationContext = { operation, entity: { type: 'planning_context' } };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['projectId', 'featureId', 'limit', 'cursor'], context, 'input');
  const projectId = validateStableId(raw.projectId, context, 'projectId');
  const featureId =
    raw.featureId === undefined || raw.featureId === null
      ? null
      : validateStableId(raw.featureId, context, 'featureId');
  return { projectId, featureId };
}

export interface ValidatedPlanningContextTargetInput {
  readonly projectId: string;
  readonly candidateId: string;
}

/** planning.context.get / planning.candidate.get 输入校验（字段集冻结）。 */
export function validatePlanningContextTargetInput(
  value: unknown,
  operation: string,
): ValidatedPlanningContextTargetInput {
  const context: ValidationContext = { operation, entity: { type: 'planning_context' } };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['projectId', 'candidateId'], context, 'input');
  return {
    projectId: validateStableId(raw.projectId, context, 'projectId'),
    candidateId: validateStableId(raw.candidateId, context, 'candidateId'),
  };
}

/**
 * 规划查询目标「不可见/不存在/跨项目」统一 not_found（同一形状纪律：不区分
 * 存在性，不回显归属或实体身份）；能力缺失仍先行 forbidden。
 */
export function planningQueryTargetNotFound(
  operation: PlanningQueryOperation | string,
): never {
  throw new PublicError('not_found', operation, '规划实体不存在或不可见', {
    details: { reason: 'planning_entity_not_found', entityType: 'planning_context' },
  });
}

/**
 * 候选正文读取失败的 fail-closed 错误（缺失/损坏/身份漂移明确区分，绝不降级
 * 为「无候选」或伪造空正文）。
 */
export function planningCandidateBodyError(
  operation: PlanningQueryOperation | string,
  reason:
    | 'candidate_artifact_missing'
    | 'candidate_artifact_not_ready'
    | 'candidate_artifact_kind_mismatch'
    | 'candidate_artifact_changed'
    | 'candidate_body_missing'
    | 'candidate_body_size_limit'
    | 'candidate_body_corrupt'
    | 'candidate_payload_invalid'
    | 'candidate_identity_mismatch'
    | 'candidate_digest_mismatch',
): never {
  throw new PublicError('corrupt_state', operation, '候选正文不可读取', { details: { reason } });
}