/**
 * P05-1 / F-002 规划上下文窄存储契约（ports 契约层：类型、常量与纯校验/纯规则；
 * 无 I/O、无时钟、无数据库、无模型调用）。
 *
 * 设计依据：input/p05-planning.md（FR-1~FR-4：一次性规划绑定 Project/Phase/Feature、
 * 规划 Run 与候选身份；候选保存为制品；批准绑定 candidate digest 原子应用，拒绝
 * 保留原因结束；plan 与编码排他，恢复不重复导入）、core-design/02 §2（plan Run
 * 创建一个 planning Task；候选计划保存为制品，不建 PlanRevision；拒绝不倒改已
 * 结束 Run）、§9（规划 Task 按 purposeStrategies 创建配置副本）、core-design/03
 * §3（原子操作接口：不把一个原子行为拆成多个独立提交）、§6（迁移只追加，保留
 * 既有 SQL/checksum）。实施契约：docs/p05-1-planning-candidate-contract.md §6/§7
 * （candidateId 随 Run 持久绑定；单候选；批准才原子应用）。
 *
 * 契约要点：
 * - **窄存储**：planning_contexts 只持久绑定一次规划的身份与依据事实——
 *   Project/Phase/Feature、规划 Run（Run.purpose=plan）、planning Task、
 *   candidateId、输入身份（inputDigest）、目标 revision/计划摘要（应用候选时的
 *   CAS 依据）、候选 Artifact/摘要（发布后写入，未生成时恒为 NULL，不伪造内容
 *   摘要）及后续决策/应用关联。预算、队列、Artifact 正文、审批决策正文一律
 *   复用既有设施（Run/Attempt/Artifact/Approval/原子命令），本表不复制。
 * - planning Task 以既有 tasks.kind='planning' 保存（PLANNING_TASK_KIND），由
 *   存储原语在同一事务内创建并与 Run 绑定；Task ID 由存储生成，与业务 Task
 *   的全局唯一身份冲突即拒绝（不覆盖）。规划任务不进入业务计划视图/替换成员
 *   身份/执行预览编码范围（交付 DAG、Feature 通过计数与代码提交收尾随之排除）。
 * - 状态机（DDL CHECK + 纯规则双重约束）：open →（发布候选）candidate_published
 *   →（人工决策）applied | rejected；open/candidate_published → cancelled（由
 *   后续取消/失败结算 Task 接线）。身份列（绑定关系/摘要/目标 revision）插入后
 *   不可变；候选绑定与决策结果各只能写入一次（DDL 触发器防御纵深），重复发布
 *   同身份候选复用原记录（稳定重放），不同身份即冲突。
 * - 规划用途策略副本（PlanningStrategyCopy）：schemaVersion=2 标记 + 完整策略
 *   条目（runtime/provider/model/credentialRef/endpointRef），复用 settings-schema
 *   的完整条目校验（缺字段/未知键/秘密正文一律拒绝）。副本在创建时冻结，后续
 *   默认配置变化不追溯改写（选择规则见 application/task-strategy-selection 的
 *   selectPlanningPurposeStrategy：purposeStrategies.planner → defaultStrategy
 *   受控回退，无条目拒绝；不取 modelMap 复杂度路由，不隐式指定厂商或模型）。
 * - 错误纪律：输入校验错误复用 StorageError kind='validation'（details 只含
 *   field/reason 定位）；读取映射对损坏行（非法枚举/摘要、JSON 损坏、绑定漂移）
 *   以 kind='corrupt' fail-closed，不作为有效记录返回。
 *
 * 本契约不实现：规划启动命令与预算/派发（F-003/F-005）、不可变规划输入与工作区
 * 绑定（F-004）、候选提交工具通道与 Artifact 发布命令（F-006，本模块只提供发布
 * 事实的存储原语）、批准决策命令与计划原子应用编排（F-008）、取消/超时结算
 * （F-009）与授权查询（F-011）。不引入 PlanRevision、独立预算或队列。
 */
import { PLANNING_RUN_PURPOSE, PLANNING_TASK_KIND } from './planning-candidates.js';
import {
  SETTINGS_SCHEMA_VERSION,
  validateRuntimeStrategy,
} from './settings-schema.js';
import type { RuntimeStrategyV1 } from './settings-schema.js';
import {
  validatePlanAcceptance,
  validatePlanArtifactRefs,
} from './feature-plan.js';
import type { PlanArtifactRef } from './feature-plan.js';
import { StorageError } from './errors.js';
import type { StorageEntityRef } from './errors.js';
import {
  DESCRIPTION_MAX_LENGTH,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 状态与领域常量
 * ------------------------------------------------------------------ */

/**
 * 规划上下文生命周期（DDL CHECK 冻结枚举）：
 * - open：规划已启动（planning Task 已创建），候选尚未发布；
 * - candidate_published：候选 Artifact 已发布并绑定摘要（单候选，不可再发布第二个）；
 * - applied：人工批准且业务计划已原子应用（决策/应用关联已写入）；
 * - rejected：人工拒绝（保留原因，Run 自然结束，可再发起全新规划）；
 * - cancelled：取消/超时/失败结算终态（由后续 Task 接线，不允许复活）。
 */
export const PLANNING_CONTEXT_STATUSES = [
  'open',
  'candidate_published',
  'applied',
  'rejected',
  'cancelled',
] as const;
export type PlanningContextStatus = (typeof PLANNING_CONTEXT_STATUSES)[number];

/** 候选人工决策（首版显式人工决策；模型不能自批通过）。 */
export const PLANNING_CONTEXT_DECISIONS = ['approved', 'rejected'] as const;
export type PlanningContextDecision = (typeof PLANNING_CONTEXT_DECISIONS)[number];

/**
 * 活动规划状态集（迁移 v35 部分唯一索引同源）：open/candidate_published 视为
 * 规划仍在途（applied/rejected/cancelled 为终态，不阻塞新规划）。
 */
export const PLANNING_CONTEXT_ACTIVE_STATUSES = ['open', 'candidate_published'] as const;

/** 合法状态迁移（纯规则；非法迁移在应用层 conflict、在 DDL 层由枚举兜底）。 */
export const PLANNING_CONTEXT_TRANSITIONS: Readonly<
  Record<PlanningContextStatus, readonly PlanningContextStatus[]>
> = Object.freeze({
  open: ['candidate_published', 'cancelled'],
  candidate_published: ['applied', 'rejected', 'cancelled'],
  applied: [],
  rejected: [],
  cancelled: [],
});

/** 规划用途策略副本的来源词汇（用途选择只有配置来源，无用户整体覆盖路径）。 */
export const PLANNING_CONTEXT_CONFIG_SOURCES = ['project_default', 'global_default'] as const;
export type PlanningConfigSource = (typeof PLANNING_CONTEXT_CONFIG_SOURCES)[number];

/** 候选审批摘要长度上限（与 PLANNING_CANDIDATE_SUMMARY_MAX_CODE_POINTS 同源）。 */
export const PLANNING_CONTEXT_SUMMARY_MAX_CODE_POINTS = 2000;

/** 决策原因长度上限（与既有派发/隔离原因上限一致；不含正文/凭据）。 */
export const PLANNING_CONTEXT_REASON_MAX_LENGTH = 512;

/** planning Task 标题长度上限（与 Phase/Feature 标题上限同量级）。 */
export const PLANNING_CONTEXT_TITLE_MAX_LENGTH = 200;

/** planning Task 需求制品引用数量上限（与规划请求 requirementRefs 同源）。 */
export const PLANNING_CONTEXT_REQUIREMENT_REFS_MAX_COUNT = 16;

/** 策略来源键长度上限（仅追踪用途的解释字符串）。 */
export const PLANNING_CONTEXT_SOURCE_KEY_MAX_LENGTH = 128;

/* ------------------------------------------------------------------ *
 * 规划用途策略副本（PlanningStrategyCopy）
 * ------------------------------------------------------------------ */

/**
 * 规划用途策略完整副本（tasks.execution_config 内 planning Task 的持久形态）：
 * schemaVersion=2 标记 + 完整策略条目。副本在创建时冻结；后续默认配置变化不追溯
 * 改写。不含 maxCodeAttempts/timeLimits 等编码政策捕获（规划任务不在编码 DAG/预算
 * 语义内；规划 Run 的时限由 Run 冻结的 runTimeLimitMs 表达）。
 */
export interface PlanningStrategyCopy {
  readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  readonly runtime: string;
  readonly provider: string;
  readonly model: string;
  readonly credentialRef?: string;
  readonly endpointRef?: string;
}

const STRATEGY_COPY_KEYS = [
  'schemaVersion',
  'runtime',
  'provider',
  'model',
  'credentialRef',
  'endpointRef',
] as const;

/**
 * 校验规划用途策略副本（写入与读取两侧共用）：schemaVersion=2 标记 + 完整条目，
 * 复用 settings-schema 的 validateRuntimeStrategy（缺任一必需策略字段、未知字段、
 * 秘密正文字段、非法引用一律拒绝）。返回全新独立对象（不与输入共享引用）。
 */
export function validatePlanningStrategyCopy(value: unknown, operation: string): PlanningStrategyCopy {
  const context: ValidationContext = { operation, entity: { type: 'task' } };
  const object = requirePlainObject(value, context, 'strategy');
  rejectUnknownKeys(object, STRATEGY_COPY_KEYS, context, 'strategy');
  if (object.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw validationError(
      context,
      'strategy.schemaVersion',
      `必须是 ${SETTINGS_SCHEMA_VERSION}（schemaVersion=2 标记的完整策略副本）`,
      object.schemaVersion,
    );
  }
  const entry: Record<string, unknown> = {
    runtime: object.runtime,
    provider: object.provider,
    model: object.model,
  };
  if (object.credentialRef !== undefined) {
    entry.credentialRef = object.credentialRef;
  }
  if (object.endpointRef !== undefined) {
    entry.endpointRef = object.endpointRef;
  }
  const strategy: RuntimeStrategyV1 = validateRuntimeStrategy(entry, context, 'strategy');
  const copy: {
    schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
    runtime: string;
    provider: string;
    model: string;
    credentialRef?: string;
    endpointRef?: string;
  } = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    runtime: strategy.runtime,
    provider: strategy.provider,
    model: strategy.model,
  };
  if (strategy.credentialRef !== undefined) {
    copy.credentialRef = strategy.credentialRef;
  }
  if (strategy.endpointRef !== undefined) {
    copy.endpointRef = strategy.endpointRef;
  }
  return copy;
}

/* ------------------------------------------------------------------ *
 * 记录类型
 * ------------------------------------------------------------------ */

/** 已发布候选的 Artifact 身份级引用（发布前为 null，不伪造内容摘要）。 */
export interface PlanningCandidateArtifactRef {
  readonly artifactId: string;
  readonly contentHash: string;
}

/** planning Task 的存储快照（读取时与上下文绑定一并核验）。 */
export interface PlanningTaskSnapshot {
  readonly id: string;
  readonly kind: typeof PLANNING_TASK_KIND;
  /** 持久状态（pending/running/passed/...；由后续执行 Task 推进）。 */
  readonly status: string;
  /** 冻结的策略副本（读取时重新完整校验；损坏即 corrupt）。 */
  readonly executionConfig: PlanningStrategyCopy;
  readonly configSource: PlanningConfigSource;
  readonly configSourceKey: string | null;
}

/** 规划上下文记录（planning_contexts 行 + 绑定的 planning Task 快照）。 */
export interface PlanningContextRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly updatedAtUtcMs: number;
  readonly phaseId: string;
  readonly featureId: string;
  /** 规划 Run（Run.purpose=plan；创建时核验归属与用途）。 */
  readonly runId: string;
  readonly planningTaskId: string;
  /** 稳定候选身份（创建时生成并随 Run 持久绑定）。 */
  readonly candidateId: string;
  /** 规划输入身份摘要（computePlanningInputDigest；输入变化使旧候选依据失效）。 */
  readonly inputDigest: string;
  /** 规划启动时的 Feature revision（应用候选时的 CAS 目标依据）。 */
  readonly targetRevision: number;
  /** 规划启动时的当前计划摘要（首次规划草稿为 null）。 */
  readonly planDigest: string | null;
  readonly status: PlanningContextStatus;
  /** 候选 Artifact 引用/摘要/审批摘要（发布前恒为 null）。 */
  readonly candidateArtifactRef: PlanningCandidateArtifactRef | null;
  readonly candidateDigest: string | null;
  readonly candidateSummary: string | null;
  /** 人工决策与原因（决策前恒为 null）。 */
  readonly decision: PlanningContextDecision | null;
  readonly decisionReason: string | null;
  readonly decidedAtUtcMs: number | null;
  /** 应用关联：批准原子应用后的 Feature revision 与时刻（拒绝/未决策为 null）。 */
  readonly appliedRevision: number | null;
  readonly appliedAtUtcMs: number | null;
  /** 绑定的 planning Task 快照（读取时核验 kind/策略副本一致性）。 */
  readonly planningTask: PlanningTaskSnapshot;
}

/* ------------------------------------------------------------------ *
 * 创建输入
 * ------------------------------------------------------------------ */

/** planning Task 的业务字段（由启动命令从规划请求派生；策略副本单独传入）。 */
export interface PlanningTaskCreateFields {
  readonly title: string;
  readonly description: string | null;
  readonly acceptance: { readonly criteria: readonly string[] };
  readonly requirementsRefs: readonly PlanArtifactRef[];
}

/** 一次规划上下文创建输入（规划启动命令在同一事务内调用存储原语）。 */
export interface PlanningContextCreateInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly inputDigest: string;
  readonly targetRevision: number;
  readonly planDigest: string | null;
  readonly planningTask: PlanningTaskCreateFields;
  readonly strategy: PlanningStrategyCopy;
  readonly strategySource: {
    readonly configSource: PlanningConfigSource;
    readonly configSourceKey: string | null;
  };
}

export interface ValidatedPlanningContextCreateInput extends PlanningContextCreateInput {
  readonly planningTask: {
    readonly title: string;
    readonly description: string | null;
    readonly acceptance: { readonly criteria: string[] };
    readonly requirementsRefs: PlanArtifactRef[];
  };
}

/* ------------------------------------------------------------------ *
 * 发布与决策输入
 * ------------------------------------------------------------------ */

/** 候选发布事实输入（F-006 的受管 Artifact 发布完成后写入）。 */
export interface PlanningCandidatePublicationInput {
  readonly projectId: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly artifactId: string;
  readonly contentHash: string;
  readonly summary: string;
}

/** 候选人工决策输入（F-008 的批准/拒绝命令在同一事务内调用）。 */
export interface PlanningCandidateDecisionInput {
  readonly projectId: string;
  readonly candidateId: string;
  readonly decision: PlanningContextDecision;
  readonly reason: string | null;
  /** 批准必填（原子应用后的 Feature revision）；拒绝必须为 null。 */
  readonly appliedRevision: number | null;
}

/* ------------------------------------------------------------------ *
 * 纯校验（输入边界 unknown；未知键一律拒绝）
 * ------------------------------------------------------------------ */

function contextOf(operation: string, id?: string): ValidationContext {
  const entity: StorageEntityRef = { type: 'planning_context' };
  return { operation, entity: id === undefined ? entity : { ...entity, id } };
}

const CREATE_INPUT_KEYS = [
  'projectId',
  'phaseId',
  'featureId',
  'runId',
  'candidateId',
  'inputDigest',
  'targetRevision',
  'planDigest',
  'planningTask',
  'strategy',
  'strategySource',
] as const;
const PLANNING_TASK_KEYS = ['title', 'description', 'acceptance', 'requirementsRefs'] as const;
const STRATEGY_SOURCE_KEYS = ['configSource', 'configSourceKey'] as const;
const PUBLICATION_KEYS = ['projectId', 'candidateId', 'candidateDigest', 'artifactId', 'contentHash', 'summary'] as const;
const DECISION_KEYS = ['projectId', 'candidateId', 'decision', 'reason', 'appliedRevision'] as const;

function validatePlanningTaskTitle(value: unknown, context: ValidationContext, field: string): string {
  const text = requireNonEmptyString(value, context, field);
  if ([...text].length > PLANNING_CONTEXT_TITLE_MAX_LENGTH) {
    throw validationError(
      context,
      field,
      `长度不得超过 ${PLANNING_CONTEXT_TITLE_MAX_LENGTH} 个字符（Unicode 码点）`,
      value,
    );
  }
  return text;
}

function validatePlanningTaskDescription(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const text = requireNonEmptyString(value, context, field);
  if ([...text].length > DESCRIPTION_MAX_LENGTH) {
    throw validationError(
      context,
      field,
      `长度不得超过 ${DESCRIPTION_MAX_LENGTH} 个字符（Unicode 码点）`,
      value,
    );
  }
  return text;
}

function validateDecisionReason(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const text = requireNonEmptyString(value, context, field);
  if ([...text].length > PLANNING_CONTEXT_REASON_MAX_LENGTH) {
    throw validationError(
      context,
      field,
      `长度不得超过 ${PLANNING_CONTEXT_REASON_MAX_LENGTH} 个字符（Unicode 码点）`,
      value,
    );
  }
  return text;
}

function validateCandidateSummary(value: unknown, context: ValidationContext, field: string): string {
  const text = requireNonEmptyString(value, context, field);
  if ([...text].length > PLANNING_CONTEXT_SUMMARY_MAX_CODE_POINTS) {
    throw validationError(
      context,
      field,
      `长度不得超过 ${PLANNING_CONTEXT_SUMMARY_MAX_CODE_POINTS} 个字符（Unicode 码点）`,
      value,
    );
  }
  return text;
}

function requireConfigSource(value: unknown, context: ValidationContext, field: string): PlanningConfigSource {
  if (
    typeof value !== 'string' ||
    !(PLANNING_CONTEXT_CONFIG_SOURCES as readonly string[]).includes(value)
  ) {
    throw validationError(
      context,
      field,
      `必须是 ${PLANNING_CONTEXT_CONFIG_SOURCES.join(' / ')}（用途策略只有配置来源）`,
      value,
    );
  }
  return value as PlanningConfigSource;
}

/** 校验一次规划上下文创建输入（含 planning Task 业务字段与策略副本完整语义）。 */
export function validatePlanningContextCreateInput(
  value: unknown,
  operation: string,
): ValidatedPlanningContextCreateInput {
  const context = contextOf(operation);
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, CREATE_INPUT_KEYS, context, 'input');

  const taskObject = requirePlainObject(object.planningTask, context, 'planningTask');
  rejectUnknownKeys(taskObject, PLANNING_TASK_KEYS, context, 'planningTask');
  const acceptance = validatePlanAcceptance(taskObject.acceptance, context, 'planningTask.acceptance');

  const sourceObject = requirePlainObject(object.strategySource, context, 'strategySource');
  rejectUnknownKeys(sourceObject, STRATEGY_SOURCE_KEYS, context, 'strategySource');
  const configSourceKey =
    sourceObject.configSourceKey === undefined || sourceObject.configSourceKey === null
      ? null
      : (() => {
          const text = requireNonEmptyString(sourceObject.configSourceKey, context, 'strategySource.configSourceKey');
          if (text.length > PLANNING_CONTEXT_SOURCE_KEY_MAX_LENGTH) {
            throw validationError(
              context,
              'strategySource.configSourceKey',
              `长度不得超过 ${PLANNING_CONTEXT_SOURCE_KEY_MAX_LENGTH}`,
              sourceObject.configSourceKey,
            );
          }
          return text;
        })();

  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    phaseId: validateStableId(object.phaseId, context, 'phaseId'),
    featureId: validateStableId(object.featureId, context, 'featureId'),
    runId: validateStableId(object.runId, context, 'runId'),
    candidateId: validateStableId(object.candidateId, context, 'candidateId'),
    inputDigest: validateSha256Digest(object.inputDigest, context, 'inputDigest'),
    targetRevision: validatePositiveInteger(object.targetRevision, context, 'targetRevision'),
    planDigest:
      object.planDigest === undefined || object.planDigest === null
        ? null
        : validateSha256Digest(object.planDigest, context, 'planDigest'),
    planningTask: {
      title: validatePlanningTaskTitle(taskObject.title, context, 'planningTask.title'),
      description: validatePlanningTaskDescription(taskObject.description, context, 'planningTask.description'),
      acceptance,
      requirementsRefs: validatePlanArtifactRefs(
        taskObject.requirementsRefs,
        context,
        'planningTask.requirementsRefs',
        PLANNING_CONTEXT_REQUIREMENT_REFS_MAX_COUNT,
      ),
    },
    strategy: validatePlanningStrategyCopy(object.strategy, operation),
    strategySource: {
      configSource: requireConfigSource(sourceObject.configSource, context, 'strategySource.configSource'),
      configSourceKey,
    },
  };
}

/** 校验候选发布事实输入（候选摘要/Artifact 引用/审批摘要形状）。 */
export function validatePlanningCandidatePublicationInput(
  value: unknown,
  operation: string,
): PlanningCandidatePublicationInput {
  const context = contextOf(operation);
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, PUBLICATION_KEYS, context, 'input');
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    candidateId: validateStableId(object.candidateId, context, 'candidateId'),
    candidateDigest: validateSha256Digest(object.candidateDigest, context, 'candidateDigest'),
    artifactId: validateStableId(object.artifactId, context, 'artifactId'),
    contentHash: validateSha256Digest(object.contentHash, context, 'contentHash'),
    summary: validateCandidateSummary(object.summary, context, 'summary'),
  };
}

/** 校验候选人工决策输入（批准必须携带应用后 revision；拒绝不得携带）。 */
export function validatePlanningCandidateDecisionInput(
  value: unknown,
  operation: string,
): PlanningCandidateDecisionInput {
  const context = contextOf(operation);
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, DECISION_KEYS, context, 'input');
  const decision = object.decision;
  if (
    typeof decision !== 'string' ||
    !(PLANNING_CONTEXT_DECISIONS as readonly string[]).includes(decision)
  ) {
    throw validationError(
      context,
      'decision',
      `必须是 ${PLANNING_CONTEXT_DECISIONS.join(' / ')}（首版仅显式人工决策）`,
      decision,
    );
  }
  const appliedRevision =
    object.appliedRevision === undefined || object.appliedRevision === null
      ? null
      : validatePositiveInteger(object.appliedRevision, context, 'appliedRevision');
  if (decision === 'approved' && appliedRevision === null) {
    throw validationError(
      context,
      'appliedRevision',
      '批准决策必须携带原子应用后的 Feature revision（appliedRevision）',
      object.appliedRevision,
    );
  }
  if (decision === 'rejected' && appliedRevision !== null) {
    throw validationError(
      context,
      'appliedRevision',
      '拒绝决策不得携带 appliedRevision（拒绝不应用计划）',
      object.appliedRevision,
    );
  }
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    candidateId: validateStableId(object.candidateId, context, 'candidateId'),
    decision: decision as PlanningContextDecision,
    reason: validateDecisionReason(object.reason, context, 'reason'),
    appliedRevision,
  };
}

/* ------------------------------------------------------------------ *
 * 记录与状态纯规则
 * ------------------------------------------------------------------ */

const RECORD_KEYS = [
  'id',
  'createdAtUtcMs',
  'projectId',
  'updatedAtUtcMs',
  'phaseId',
  'featureId',
  'runId',
  'planningTaskId',
  'candidateId',
  'inputDigest',
  'targetRevision',
  'planDigest',
  'status',
  'candidateArtifactRef',
  'candidateDigest',
  'candidateSummary',
  'decision',
  'decisionReason',
  'decidedAtUtcMs',
  'appliedRevision',
  'appliedAtUtcMs',
  'planningTask',
] as const;
const PLANNING_TASK_SNAPSHOT_KEYS = ['id', 'kind', 'status', 'executionConfig', 'configSource', 'configSourceKey'] as const;

function requireStatus(value: unknown, context: ValidationContext, field: string): PlanningContextStatus {
  if (typeof value !== 'string' || !(PLANNING_CONTEXT_STATUSES as readonly string[]).includes(value)) {
    throw validationError(context, field, `必须是 ${PLANNING_CONTEXT_STATUSES.join(' / ')}`, value);
  }
  return value as PlanningContextStatus;
}

/**
 * 校验规划上下文记录（读取映射后、返回调用方前）：字段形状、摘要、时间序与
 * 状态-候选-决策一致性（与 DDL CHECK 同一组规则）。非法即 validation（由适配器
 * 包装为 corrupt），损坏行不作为有效记录返回。
 */
export function validatePlanningContextRecord(value: unknown, operation: string): PlanningContextRecord {
  const raw = requirePlainObject(value, contextOf(operation), 'record');
  const context = contextOf(operation, typeof raw.id === 'string' ? raw.id : undefined);
  rejectUnknownKeys(raw, RECORD_KEYS, context, 'record');
  const status = requireStatus(raw.status, context, 'status');
  const createdAtUtcMs = validateNonNegativeInteger(raw.createdAtUtcMs, context, 'createdAtUtcMs');
  const updatedAtUtcMs = validateNonNegativeInteger(raw.updatedAtUtcMs, context, 'updatedAtUtcMs');
  if (updatedAtUtcMs < createdAtUtcMs) {
    throw validationError(context, 'updatedAtUtcMs', '更新时间不得早于创建时间', updatedAtUtcMs);
  }
  const decidedAtUtcMs =
    raw.decidedAtUtcMs === undefined || raw.decidedAtUtcMs === null
      ? null
      : validatePositiveInteger(raw.decidedAtUtcMs, context, 'decidedAtUtcMs');
  const appliedAtUtcMs =
    raw.appliedAtUtcMs === undefined || raw.appliedAtUtcMs === null
      ? null
      : validatePositiveInteger(raw.appliedAtUtcMs, context, 'appliedAtUtcMs');
  const appliedRevision =
    raw.appliedRevision === undefined || raw.appliedRevision === null
      ? null
      : validatePositiveInteger(raw.appliedRevision, context, 'appliedRevision');
  const candidateDigest =
    raw.candidateDigest === undefined || raw.candidateDigest === null
      ? null
      : validateSha256Digest(raw.candidateDigest, context, 'candidateDigest');
  const candidateSummary =
    raw.candidateSummary === undefined || raw.candidateSummary === null
      ? null
      : validateCandidateSummary(raw.candidateSummary, context, 'candidateSummary');
  const decision =
    raw.decision === undefined || raw.decision === null
      ? null
      : (() => {
          if (typeof raw.decision !== 'string' || !(PLANNING_CONTEXT_DECISIONS as readonly string[]).includes(raw.decision)) {
            throw validationError(context, 'decision', `必须是 ${PLANNING_CONTEXT_DECISIONS.join(' / ')} 或 null`, raw.decision);
          }
          return raw.decision as PlanningContextDecision;
        })();
  const artifactRef =
    raw.candidateArtifactRef === undefined || raw.candidateArtifactRef === null
      ? null
      : (() => {
          const ref = requirePlainObject(raw.candidateArtifactRef, context, 'candidateArtifactRef');
          rejectUnknownKeys(ref, ['artifactId', 'contentHash'], context, 'candidateArtifactRef');
          return {
            artifactId: validateStableId(ref.artifactId, context, 'candidateArtifactRef.artifactId'),
            contentHash: validateSha256Digest(ref.contentHash, context, 'candidateArtifactRef.contentHash'),
          };
        })();

  // 状态-候选一致性：open 无候选事实；candidate_published/applied/rejected 候选齐备
  //（rejected 也必须先发布过候选——决策对象是候选）；cancelled 允许两种形态。
  const candidateComplete =
    artifactRef !== null && candidateDigest !== null && candidateSummary !== null;
  if (status === 'open' && (artifactRef !== null || candidateDigest !== null || candidateSummary !== null)) {
    throw validationError(context, 'candidateArtifactRef', 'open 状态不得携带候选事实（未生成时无伪造内容摘要）', status);
  }
  if ((status === 'candidate_published' || status === 'applied' || status === 'rejected') && !candidateComplete) {
    throw validationError(context, 'candidateArtifactRef', `${status} 状态候选事实必须齐备`, status);
  }
  // 决策一致性：未决策无决策字段；approved ⇒ applied + 应用关联；rejected ⇒ 无应用关联。
  if (decision === null) {
    if (decidedAtUtcMs !== null || appliedRevision !== null || appliedAtUtcMs !== null) {
      throw validationError(context, 'decision', '决策字段存在但 decision 缺失', null);
    }
    if (status === 'applied' || status === 'rejected') {
      throw validationError(context, 'status', `${status} 状态必须携带决策`, status);
    }
  } else if (decision === 'approved') {
    if (status !== 'applied' || decidedAtUtcMs === null || appliedRevision === null || appliedAtUtcMs === null) {
      throw validationError(context, 'decision', 'approved 决策必须对应 applied 状态与完整应用关联', status);
    }
  } else if (decision === 'rejected') {
    if (status !== 'rejected' || decidedAtUtcMs === null || appliedRevision !== null || appliedAtUtcMs !== null) {
      throw validationError(context, 'decision', 'rejected 决策必须对应 rejected 状态且无应用关联', status);
    }
  }

  const taskRaw = requirePlainObject(raw.planningTask, context, 'planningTask');
  rejectUnknownKeys(taskRaw, PLANNING_TASK_SNAPSHOT_KEYS, context, 'planningTask');
  if (taskRaw.kind !== PLANNING_TASK_KIND) {
    throw validationError(context, 'planningTask.kind', `必须是 ${PLANNING_TASK_KIND}`, taskRaw.kind);
  }
  const taskStatus = requireNonEmptyString(taskRaw.status, context, 'planningTask.status');
  const configSource = requireConfigSource(taskRaw.configSource, context, 'planningTask.configSource');
  const configSourceKey =
    taskRaw.configSourceKey === undefined || taskRaw.configSourceKey === null
      ? null
      : requireNonEmptyString(taskRaw.configSourceKey, context, 'planningTask.configSourceKey');

  return {
    id: validateStableId(raw.id, context, 'id'),
    createdAtUtcMs,
    projectId: validateStableId(raw.projectId, context, 'projectId'),
    updatedAtUtcMs,
    phaseId: validateStableId(raw.phaseId, context, 'phaseId'),
    featureId: validateStableId(raw.featureId, context, 'featureId'),
    runId: validateStableId(raw.runId, context, 'runId'),
    planningTaskId: validateStableId(raw.planningTaskId, context, 'planningTaskId'),
    candidateId: validateStableId(raw.candidateId, context, 'candidateId'),
    inputDigest: validateSha256Digest(raw.inputDigest, context, 'inputDigest'),
    targetRevision: validatePositiveInteger(raw.targetRevision, context, 'targetRevision'),
    planDigest:
      raw.planDigest === undefined || raw.planDigest === null
        ? null
        : validateSha256Digest(raw.planDigest, context, 'planDigest'),
    status,
    candidateArtifactRef: artifactRef,
    candidateDigest,
    candidateSummary,
    decision,
    decisionReason: validateDecisionReason(raw.decisionReason, context, 'decisionReason'),
    decidedAtUtcMs,
    appliedRevision,
    appliedAtUtcMs,
    planningTask: {
      id: validateStableId(taskRaw.id, context, 'planningTask.id'),
      kind: PLANNING_TASK_KIND,
      status: taskStatus,
      executionConfig: validatePlanningStrategyCopy(taskRaw.executionConfig, operation),
      configSource,
      configSourceKey,
    },
  };
}

/** 状态迁移纯规则（非法迁移 conflict；终态不可复活）。 */
export function assertPlanningContextTransition(
  from: PlanningContextStatus,
  to: PlanningContextStatus,
  operation: string,
): void {
  if (from === to) {
    throw new StorageError('conflict', operation, `规划上下文状态已是 ${from}（幂等重放由调用方按身份复用，不重写状态）`, {
      details: { reason: 'status_unchanged', from, to },
    });
  }
  const allowed = PLANNING_CONTEXT_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new StorageError(
      'conflict',
      operation,
      `规划上下文状态 ${from} 不允许迁移到 ${to}（合法目标：${allowed.length > 0 ? allowed.join(' / ') : '无（终态）'}）`,
      { details: { reason: 'invalid_status_transition', from, to } },
    );
  }
}
