/**
 * P03-1 / F-002 计划结构窄存储契约（ports 契约层）：Phase/Feature/Task 与
 * Task 依赖的记录形态、写输入校验与 CommandTransaction 原语签名（原语接口
 * 定义于 ports/atomic-commands.ts 的 CommandTransaction，本模块提供其输入/
 * 输出契约与纯校验器；SQLite 实现见 adapters/sqlite/plan-store.ts）。
 *
 * 协议依据：docs/p03-1-plan-import-contract.md（§2 计划 payload 契约与 §6 导入
 * CAS 契约——Task/依赖边无独立 CAS，计划修订在 Feature 聚合事务内整体替换；
 * §9.1 requirements 多引用形态由本 Feature 定案为 JSON 数组 requirements_refs）、
 * core-design/02 §1/§10（Project → Phase → Feature → Task 层级；标题/描述/标签
 * 规则；标签不继承）、core-design/11 §4（phases/features/tasks/task_dependencies
 * 字段与约束；UNIQUE(feature_id,task_id,depends_on_id)、无自依赖、无环）。
 *
 * 不变量：
 * - 输入一律 unknown，先经本模块校验器再进入持久化：校验失败零副作用
 *   （StorageError kind='validation'，details 定位字段/节点，不回显输入正文）；
 * - 复用公共端口规则，不另立第二套：标题/描述（feature-plan 的计划标题/描述
 *   规则，与项目展示名/描述同语义）、标签（normalizeLabels，默认 [] 且不继承
 *   父级）、稳定 ID（validateStableId）、摘要形态（validateSha256Digest）、
 *   complexity（配置复杂度取值）、结构化验收与制品引用（feature-plan 同一校验器）；
 * - 写原语只允许在原子命令事务（单 BEGIN IMMEDIATE）内调用：归属核验
 *   （同项目/同 Feature）在同一事务内以绑定参数查询完成，DDL 外键/复合外键/
 *   CHECK/唯一索引作为防御纵深兜底；环检测由原语在事务内 DFS 校验
 *   （DDL 无法表达；P03-1 契约 §3 应用层校验）；
 * - 时间为应用注入的 UTC 毫秒；Phase/Feature 稳定 ID 由适配器生成 UUID v4，
 *   Task 保留计划作者指定的稳定 ID（P03-1 契约 §2.1）；创建路径 revision=1，
 *   状态恒为 open/draft(+plan_status=draft)/pending，状态迁移原语随对应功能增加；
 * - executionConfig 在本契约只校验「普通 JSON 对象且有界」：完整策略语义
 *   （schemaVersion=2 策略校验、来源选择，见 application/task-strategy-selection 的
 *   selectTaskStrategy / validateTaskExecutionConfig）由 F-003 应用层校验，不在存储层重复
 *   或预冻结；本 Feature 不建 Feature DAG（feature_dependencies）、Batch/Run/
 *   Attempt/Approval 或配置/计划版本表。
 */
import { StorageError } from './errors.js';
import type { StorageEntityRef } from './errors.js';
import {
  PLAN_DEPENDENCY_EDGES_MAX_COUNT,
  PLAN_FEATURE_SOURCE_REFS_MAX_COUNT,
  PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT,
  PLAN_TASKS_MAX_COUNT,
  detectPlanDependencyCycle,
  validatePlanAcceptance,
  validatePlanArtifactRefs,
  validatePlanDescription,
  validatePlanTitle,
} from './feature-plan.js';
import type { PlanArtifactRef, PlanComplexity } from './feature-plan.js';
import {
  isPlainObject,
  normalizeLabels,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateExpectedRevision,
  validateNonNegativeInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 状态枚举（与迁移 v6 DDL CHECK 同源；创建路径只写初始值）
 * ------------------------------------------------------------------ */

/** Phase 生命周期（设计 02 §1；创建恒为 open，关闭/归档原语随后续功能增加）。 */
export const PHASE_STATUSES = ['open', 'closed', 'archived'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

/**
 * Feature 业务状态（设计 02 §5 完整枚举；计划导入创建恒为 draft，其余取值随
 * 执行/审批功能使用——先冻结枚举与 v1 projects 同一先例）。
 */
export const FEATURE_STATUSES = [
  'draft',
  'ready',
  'running',
  'awaiting_approval',
  'completed',
  'partial',
  'failed',
] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

/** 最小计划审批状态（设计 11 §4：draft/pending_approval/approved；创建恒为 draft）。 */
export const FEATURE_PLAN_STATUSES = ['draft', 'pending_approval', 'approved'] as const;
export type FeaturePlanStatus = (typeof FEATURE_PLAN_STATUSES)[number];

/** Task 持久状态（设计 02 §4；创建恒为 pending，ready/blocked 为派生视图不入库）。 */
export const TASK_STATUSES = ['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Task 复杂度取值（复用配置复杂度 low/medium/high；可空）。 */
export const TASK_COMPLEXITY_VALUES = ['low', 'medium', 'high'] as const;

/* ------------------------------------------------------------------ *
 * P03-2 / F-002 计划批准/拒绝决策（approvals 迁移 v7；设计 11 §7）
 * ------------------------------------------------------------------ */

/** 受审批主体类型（先冻结 feature_plan；后续审批对象类型随对应功能扩展迁移）。 */
export const PLAN_APPROVAL_SUBJECT_TYPES = ['feature_plan'] as const;
export type PlanApprovalSubjectType = (typeof PLAN_APPROVAL_SUBJECT_TYPES)[number];

/**
 * 决策状态（设计 11 §7 完整枚举先冻结，与 v1 projects 同一先例）：P03-2 决策
 * 命令只写 approved/rejected；pending（两段流）与 superseded（改写旧决策）
 * 随对应功能扩展，本版本无更新原语。
 */
export const PLAN_APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'superseded'] as const;
export type PlanApprovalStatus = (typeof PLAN_APPROVAL_STATUSES)[number];

/** 决策命令的决策方向词汇（approve/reject；记录状态映射为 approved/rejected）。 */
export const FEATURE_PLAN_DECISIONS = ['approve', 'reject'] as const;
export type FeaturePlanDecision = (typeof FEATURE_PLAN_DECISIONS)[number];

/** 决策原因说明上限（Unicode 码点；适用原因可选，防无界正文入库）。 */
export const PLAN_APPROVAL_REASON_MAX_CODE_POINTS = 2_000;

/**
 * executionConfig 序列化上限（字节；实施契约值）。完整策略副本是小型 JSON 对象
 * （策略条目 + 政策段引用），16 KiB 足够且防无界正文入库；超出即 validation 拒绝。
 */
export const EXECUTION_CONFIG_MAX_BYTES = 16_384;

/* ------------------------------------------------------------------ *
 * 记录形态（应用侧 camelCase；落库列名 snake_case 由适配器映射）
 * ------------------------------------------------------------------ */

export interface PhaseRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  /** 规范化标签（默认 []，不向 Feature/Task 继承）。 */
  readonly labels: readonly string[];
  readonly status: PhaseStatus;
  /** CAS 并发计数；创建为 1。 */
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

export interface FeatureRecord {
  readonly id: string;
  readonly projectId: string;
  /** 所属 Phase（同项目，由复合外键与写入核验共同保证）。 */
  readonly phaseId: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: readonly string[];
  /** 业务状态（创建恒为 draft）。 */
  readonly status: FeatureStatus;
  /** 计划审批状态（创建恒为 draft）。 */
  readonly planStatus: FeaturePlanStatus;
  /** 当前计划业务摘要（F-001 规范化 SHA-256；可空；不是 CAS 依据）。 */
  readonly planDigest: string | null;
  /** 输入来源制品引用（身份级；默认 []）。 */
  readonly sourceRefs: readonly PlanArtifactRef[];
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

export interface TaskRecord {
  /** 计划作者指定的稳定 ID（不是适配器生成的 UUID）。 */
  readonly id: string;
  readonly projectId: string;
  /** 所属 Feature（同项目）。 */
  readonly featureId: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: readonly string[];
  /** 持久状态（创建恒为 pending）。 */
  readonly status: TaskStatus;
  readonly complexity: PlanComplexity | null;
  /** 结构化验收（有序 criteria 清单；引用/描述不能替代）。 */
  readonly acceptance: { readonly criteria: readonly string[] };
  /** 需求/验收制品引用（身份级；默认 []）。 */
  readonly requirementsRefs: readonly PlanArtifactRef[];
  /** Task 可编辑完整策略副本（普通 JSON 对象；完整语义由 F-003 应用层校验，见 application/task-strategy-selection）。 */
  readonly executionConfig: Readonly<Record<string, unknown>>;
  /** 策略来源（project_default/global_default/user_override；F-003 定案，非空说明）。 */
  readonly configSource: string;
  /** 来源策略键（仅追踪用途；可空）。 */
  readonly configSourceKey: string | null;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

/** Task 依赖边（插后不可变；计划修订在 Feature 聚合事务内整体替换）。 */
export interface TaskDependencyRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly dependsOnId: string;
  readonly createdAtUtcMs: number;
}

/**
 * 计划批准/拒绝决策记录（P03-2 / F-002 迁移 v7；设计 11 §7 approvals）。
 * 决策绑定 subject_digest（feature_plan 时为提交时当前 planDigest）：主体
 * 摘要变更后旧决策自然成为历史记录（查询按摘要区分当前/历史），不改写旧行。
 * decisionActor 为可信主体 principalId（请求不能伪造身份）。
 */
export interface PlanApprovalRecord {
  readonly id: string;
  readonly projectId: string;
  readonly subjectType: PlanApprovalSubjectType;
  /** 受审批主体稳定 ID（feature_plan 时为 Feature 稳定 ID）。 */
  readonly subjectId: string;
  /** 批准绑定的主体内容摘要（64 位小写 hex）。 */
  readonly subjectDigest: string;
  /**
   * 决策绑定的适用检查政策身份摘要（P03-2 / F-003 迁移 v8；64 位小写 hex）。
   * v7 遗留行升级为 null——不等于任何当前身份（核验 fail-closed，需重新批准）。
   */
  readonly checkPolicyDigest: string | null;
  readonly status: PlanApprovalStatus;
  /** 决策人（可信主体 principalId；pending/superseded 历史形态可空）。 */
  readonly decisionActor: string | null;
  /** 适用原因（可选）。 */
  readonly reason: string | null;
  /** 决策时间 UTC 毫秒（approved/rejected 必填）。 */
  readonly decidedAtUtcMs: number | null;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

/* ------------------------------------------------------------------ *
 * 写输入校验（unknown → 已校验形态；失败零副作用）
 * ------------------------------------------------------------------ */

const CREATE_PHASE_KEYS = ['projectId', 'id', 'title', 'description', 'labels'] as const;
/** F-004 命令 payload 字段面（projectId 由信封 scope 携带，不进 payload）。 */
const PHASE_FIELD_KEYS = ['id', 'title', 'description', 'labels'] as const;
const CREATE_FEATURE_KEYS = [
  'projectId',
  'phaseId',
  'title',
  'description',
  'labels',
  'sourceRefs',
  'planDigest',
] as const;
const CREATE_TASK_DEPENDENCY_KEYS = ['projectId', 'featureId', 'taskId', 'dependsOnId'] as const;

/* ------------------------------------------------------------------ *
 * F-007 纯标签 CAS 编辑（Phase/Feature/Task 标签元数据编辑）
 * ------------------------------------------------------------------ */

/** 可编辑标签的计划实体类型（Project 标签走 project.metadata.update，不在本面）。 */
export const PLAN_ENTITY_TYPES = ['phase', 'feature', 'task'] as const;
export type PlanEntityType = (typeof PLAN_ENTITY_TYPES)[number];

const PLAN_LABELS_FIELD_KEYS = ['entityType', 'id', 'labels'] as const;
const UPDATE_PLAN_ENTITY_LABELS_KEYS = [
  'entityType',
  'projectId',
  'id',
  'labels',
  'expectedRevision',
] as const;

export interface ValidatedPlanLabelsFields {
  readonly entityType: PlanEntityType;
  readonly id: string;
  /** 规范化标签全集（复用 normalizeLabels：trim/NFC/ASCII 小写/去重 + 64/50 上限）。 */
  readonly labels: string[];
}

function requirePlanEntityType(value: unknown, context: ValidationContext): PlanEntityType {
  if (typeof value !== 'string' || !(PLAN_ENTITY_TYPES as readonly string[]).includes(value)) {
    throw validationError(context, 'entityType', `必须是 ${PLAN_ENTITY_TYPES.join(' / ')}`, value);
  }
  return value as PlanEntityType;
}

/**
 * F-007：纯标签编辑业务字段（entityType/id/labels）；严格未知键拒绝——需求/依赖/
 * 验收/状态/批准/标题/描述/revision 等一律不得经本编辑面进入（与实质计划编辑
 * 是可区分的契约）。labels 必须显式提交（编辑以完整标签集合为准，`[]` 即清空；
 * 缺省不静默清空）。
 */
export function validatePlanLabelsFields(
  value: unknown,
  operation: string,
): ValidatedPlanLabelsFields {
  const context: ValidationContext = { operation, entity: { type: 'phase' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, PLAN_LABELS_FIELD_KEYS, context, 'input');
  const entityType = requirePlanEntityType(object.entityType, context);
  const entityContext: ValidationContext = { operation, entity: { type: entityType } };
  if (!Array.isArray(object.labels)) {
    throw validationError(entityContext, 'labels', '必须是字符串数组（编辑以完整标签集合提交）', object.labels);
  }
  return {
    entityType,
    id: validateStableId(object.id, entityContext, 'id'),
    labels: normalizeLabels(object.labels, entityContext, 'labels'),
  };
}

export interface ValidatedUpdatePlanEntityLabelsInput {
  readonly entityType: PlanEntityType;
  readonly projectId: string;
  readonly id: string;
  readonly labels: string[];
  /** 目标实体自身 revision（唯一 CAS 权威；≥1 整数）。 */
  readonly expectedRevision: number;
}

/** F-007：事务写入原语输入（entityType/projectId/id/labels/expectedRevision）。 */
export function validateUpdatePlanEntityLabelsInput(
  value: unknown,
  operation: string,
): ValidatedUpdatePlanEntityLabelsInput {
  const context: ValidationContext = { operation, entity: { type: 'phase' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, UPDATE_PLAN_ENTITY_LABELS_KEYS, context, 'input');
  const entityType = requirePlanEntityType(object.entityType, context);
  const entityContext: ValidationContext = { operation, entity: { type: entityType } };
  const expectedRevision = object.expectedRevision;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    throw validationError(entityContext, 'expectedRevision', '必须是 ≥1 的安全整数', expectedRevision);
  }
  if (!Array.isArray(object.labels)) {
    throw validationError(entityContext, 'labels', '必须是字符串数组（编辑以完整标签集合提交）', object.labels);
  }
  return {
    entityType,
    projectId: validateStableId(object.projectId, entityContext, 'projectId'),
    id: validateStableId(object.id, entityContext, 'id'),
    labels: normalizeLabels(object.labels, entityContext, 'labels'),
    expectedRevision,
  };
}

/* ------------------------------------------------------------------ *
 * P03-2 / F-001 Task 策略副本 CAS 编辑（executionConfig/config_source/
 * config_source_key/revision/updated_at 单语句条件 UPDATE）
 * ------------------------------------------------------------------ */

const UPDATE_TASK_STRATEGY_KEYS = [
  'projectId',
  'taskId',
  'executionConfig',
  'configSource',
  'configSourceKey',
  'expectedRevision',
] as const;

export interface ValidatedUpdateTaskStrategyInput {
  readonly projectId: string;
  readonly taskId: string;
  /** 完整策略副本（本层只校验「普通 JSON 对象且有界」；完整语义由 F-003
   * 应用层 validateTaskExecutionConfig 校验，与创建/替换同一分层纪律）。 */
  readonly executionConfig: Record<string, unknown>;
  /** 编辑后来源（非空说明字符串；由命令用例以 task_edit 定值，不接受请求输入）。 */
  readonly configSource: string;
  readonly configSourceKey: string | null;
  /** 目标 Task 自身 revision（唯一 CAS 权威；≥1 安全整数）。 */
  readonly expectedRevision: number;
}

/**
 * P03-2 / F-001：事务写入原语输入校验（严格未知键拒绝；失败零副作用）。
 * executionConfig 与成员字段同一形状门槛（普通 JSON 对象 + 有界字节），
 * 策略语义校验不在此层重复；configSource/configSourceKey 只作非空说明
 * 字符串校验（值域由命令用例定值）。
 */
export function validateUpdateTaskStrategyInput(
  value: unknown,
  operation: string,
): ValidatedUpdateTaskStrategyInput {
  const context: ValidationContext = { operation, entity: { type: 'task' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, UPDATE_TASK_STRATEGY_KEYS, context, 'input');
  const expectedRevision = object.expectedRevision;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    throw validationError(context, 'expectedRevision', '必须是 ≥1 的安全整数', expectedRevision);
  }
  const executionConfigValue = object.executionConfig;
  if (!isPlainObject(executionConfigValue)) {
    throw validationError(
      context,
      'executionConfig',
      '必须是普通 JSON 对象（完整策略副本；完整策略语义由应用层校验）',
      executionConfigValue,
    );
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(executionConfigValue), 'utf8');
  if (serializedBytes > EXECUTION_CONFIG_MAX_BYTES) {
    throw validationError(
      context,
      'executionConfig',
      `序列化后不得超过 ${EXECUTION_CONFIG_MAX_BYTES} 字节（实际 ${serializedBytes}）`,
    );
  }
  const configSourceKey = object.configSourceKey;
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    taskId: validateStableId(object.taskId, context, 'taskId'),
    executionConfig: executionConfigValue,
    configSource: requireNonEmptyString(object.configSource, context, 'configSource').trim(),
    configSourceKey:
      configSourceKey === undefined || configSourceKey === null
        ? null
        : requireNonEmptyString(configSourceKey, context, 'configSourceKey').trim(),
    expectedRevision,
  };
}

/* ------------------------------------------------------------------ *
 * P03-2 / F-002 计划批准/拒绝决策写入面（decision 命令 payload 字段 +
 * approvals 插入与 Feature plan_status CAS 更新原语输入）
 * ------------------------------------------------------------------ */

function codePointLength(value: string): number {
  return [...value].length;
}

const FEATURE_PLAN_DECIDE_FIELD_KEYS = ['featureId', 'planDigest', 'decision', 'reason'] as const;

/** 决策命令 payload 业务字段（严格未知键拒绝；失败零副作用）。 */
export interface ValidatedFeaturePlanDecideFields {
  readonly featureId: string;
  /** 提交时绑定的目标计划摘要（必须等于当前 planDigest，否则 fail-closed）。 */
  readonly planDigest: string;
  readonly decision: FeaturePlanDecision;
  /** 适用原因（可选；全空白归一 null）。 */
  readonly reason: string | null;
}

/**
 * F-002：决策命令业务字段校验（featureId/planDigest/decision/reason）。
 * 严格未知键拒绝——decisionActor/principalId/approval/status/planStatus/
 * revision 等服务端决定字段一律不能经请求输入（payload 内出现即未知键），
 * 身份只能来自可信主体装配；reason 全空白归一 null，超限拒绝。
 */
export function validateFeaturePlanDecideFields(
  value: unknown,
  operation: string,
): ValidatedFeaturePlanDecideFields {
  const context: ValidationContext = { operation, entity: { type: 'feature' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, FEATURE_PLAN_DECIDE_FIELD_KEYS, context, 'input');
  const decision = object.decision;
  if (
    typeof decision !== 'string' ||
    !(FEATURE_PLAN_DECISIONS as readonly string[]).includes(decision)
  ) {
    throw validationError(
      context,
      'decision',
      `必须是 ${FEATURE_PLAN_DECISIONS.join(' / ')}`,
      decision,
    );
  }
  const validDecision = decision as FeaturePlanDecision;
  const reasonValue = object.reason;
  let reason: string | null = null;
  if (reasonValue !== undefined && reasonValue !== null) {
    if (typeof reasonValue !== 'string') {
      throw validationError(context, 'reason', '必须是字符串、null 或省略', reasonValue);
    }
    if (reasonValue.trim().length > 0) {
      if (codePointLength(reasonValue) > PLAN_APPROVAL_REASON_MAX_CODE_POINTS) {
        throw validationError(
          context,
          'reason',
          `长度不得超过 ${PLAN_APPROVAL_REASON_MAX_CODE_POINTS} 个字符（Unicode 码点）`,
          reasonValue,
        );
      }
      reason = reasonValue.trim();
    }
  }
  return {
    featureId: validateStableId(object.featureId, context, 'featureId'),
    planDigest: validateSha256Digest(object.planDigest, context, 'planDigest'),
    decision: validDecision,
    reason,
  };
}

const INSERT_PLAN_APPROVAL_KEYS = [
  'projectId',
  'subjectType',
  'subjectId',
  'subjectDigest',
  'checkPolicyDigest',
  'status',
  'decisionActor',
  'reason',
  'decidedAtUtcMs',
] as const;

export interface ValidatedInsertPlanApprovalInput {
  readonly projectId: string;
  readonly subjectType: PlanApprovalSubjectType;
  readonly subjectId: string;
  readonly subjectDigest: string;
  /**
   * 决策绑定的适用检查政策身份摘要（P03-2 / F-003；必填，由命令用例在同一
   * 写事务内从当前有效配置计算定值，不接受请求输入）。
   */
  readonly checkPolicyDigest: string;
  /** P03-2 决策命令只写 approved/rejected（pending/superseded 随后续功能扩展）。 */
  readonly status: 'approved' | 'rejected';
  /** 决策人（非空；由命令用例以可信主体 principalId 定值，不接受请求输入）。 */
  readonly decisionActor: string;
  readonly reason: string | null;
  readonly decidedAtUtcMs: number;
}

/**
 * F-002：approvals 决策记录插入原语输入校验（严格未知键拒绝；失败零副作用）。
 * 已决定形态在端口层先行校验（approved/rejected 必须携带决策人与决策时间），
 * DDL CHECK 作防御纵深；revision 恒为 1，不接受请求输入。
 */
export function validateInsertPlanApprovalInput(
  value: unknown,
  operation: string,
): ValidatedInsertPlanApprovalInput {
  const context: ValidationContext = { operation, entity: { type: 'feature' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, INSERT_PLAN_APPROVAL_KEYS, context, 'input');
  const subjectTypeValue = object.subjectType;
  if (
    typeof subjectTypeValue !== 'string' ||
    !(PLAN_APPROVAL_SUBJECT_TYPES as readonly string[]).includes(subjectTypeValue)
  ) {
    throw validationError(
      context,
      'subjectType',
      `必须是 ${PLAN_APPROVAL_SUBJECT_TYPES.join(' / ')}`,
      subjectTypeValue,
    );
  }
  const subjectType = subjectTypeValue as PlanApprovalSubjectType;
  const status = object.status;
  if (status !== 'approved' && status !== 'rejected') {
    throw validationError(
      context,
      'status',
      '决策插入只允许 approved / rejected（pending/superseded 随后续功能扩展）',
      status,
    );
  }
  const reasonValue = object.reason;
  if (reasonValue !== undefined && reasonValue !== null && typeof reasonValue !== 'string') {
    throw validationError(context, 'reason', '必须是字符串、null 或省略', reasonValue);
  }
  if (typeof reasonValue === 'string' && codePointLength(reasonValue) > PLAN_APPROVAL_REASON_MAX_CODE_POINTS) {
    throw validationError(
      context,
      'reason',
      `长度不得超过 ${PLAN_APPROVAL_REASON_MAX_CODE_POINTS} 个字符（Unicode 码点）`,
      reasonValue,
    );
  }
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    subjectType,
    subjectId: validateStableId(object.subjectId, context, 'subjectId'),
    subjectDigest: validateSha256Digest(object.subjectDigest, context, 'subjectDigest'),
    checkPolicyDigest: validateSha256Digest(object.checkPolicyDigest, context, 'checkPolicyDigest'),
    status,
    decisionActor: requireNonEmptyString(object.decisionActor, context, 'decisionActor').trim(),
    reason: reasonValue === undefined || reasonValue === null ? null : (reasonValue as string).trim(),
    decidedAtUtcMs: validateNonNegativeInteger(object.decidedAtUtcMs, context, 'decidedAtUtcMs'),
  };
}

const UPDATE_FEATURE_PLAN_STATUS_KEYS = [
  'projectId',
  'featureId',
  'planStatus',
  'expectedRevision',
] as const;

export interface ValidatedUpdateFeaturePlanStatusInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly planStatus: FeaturePlanStatus;
  /** Feature 聚合 revision（唯一 CAS 权威；≥1 安全整数）。 */
  readonly expectedRevision: number;
}

/**
 * F-002：Feature 计划审批状态 CAS 更新原语输入校验（严格未知键拒绝；失败零
 * 副作用）。单语句条件 UPDATE 只触达 plan_status/revision/updated_at；计划
 * 内容/摘要/标题等一律不经本原语（实质变化走 feature.plan.revise）。
 */
export function validateUpdateFeaturePlanStatusInput(
  value: unknown,
  operation: string,
): ValidatedUpdateFeaturePlanStatusInput {
  const context: ValidationContext = { operation, entity: { type: 'feature' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, UPDATE_FEATURE_PLAN_STATUS_KEYS, context, 'input');
  const planStatus = object.planStatus;
  if (typeof planStatus !== 'string' || !(FEATURE_PLAN_STATUSES as readonly string[]).includes(planStatus)) {
    throw validationError(
      context,
      'planStatus',
      `必须是 ${FEATURE_PLAN_STATUSES.join(' / ')}`,
      planStatus,
    );
  }
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    featureId: validateStableId(object.featureId, context, 'featureId'),
    planStatus: planStatus as FeaturePlanStatus,
    expectedRevision: validateExpectedRevision(object.expectedRevision, context),
  };
}

export interface ValidatedCreatePhaseInput {
  /** 调用方指定的稳定 ID；缺省 null 时由适配器生成 UUID v4（F-002 定案保持不变）。 */
  readonly id: string | null;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: string[];
}

/** Phase 业务字段（id/title/description/labels）共用校验；id 可缺省。 */
export interface ValidatedPhaseFields {
  readonly id: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly labels: string[];
}

export function validatePhaseFields(value: unknown, operation: string): ValidatedPhaseFields {
  const context: ValidationContext = { operation, entity: { type: 'phase' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, PHASE_FIELD_KEYS, context, 'input');
  const idValue = object.id;
  return {
    id: idValue === undefined || idValue === null ? null : validateStableId(idValue, context, 'id'),
    title: validatePlanTitle(object.title, context, 'title'),
    description: validatePlanDescription(object.description, context, 'description'),
    labels: normalizeLabels(object.labels, context),
  };
}

export function validateCreatePhaseInput(value: unknown, operation: string): ValidatedCreatePhaseInput {
  const context: ValidationContext = { operation, entity: { type: 'phase' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, CREATE_PHASE_KEYS, context, 'input');
  const idValue = object.id;
  return {
    id: idValue === undefined || idValue === null ? null : validateStableId(idValue, context, 'id'),
    projectId: validateStableId(object.projectId, context, 'projectId'),
    title: validatePlanTitle(object.title, context, 'title'),
    description: validatePlanDescription(object.description, context, 'description'),
    labels: normalizeLabels(object.labels, context),
  };
}

export interface ValidatedCreateFeatureInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: string[];
  readonly sourceRefs: PlanArtifactRef[];
  readonly planDigest: string | null;
}

export function validateCreateFeatureInput(value: unknown, operation: string): ValidatedCreateFeatureInput {
  const context: ValidationContext = { operation, entity: { type: 'feature' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, CREATE_FEATURE_KEYS, context, 'input');
  const planDigest =
    object.planDigest === undefined || object.planDigest === null
      ? null
      : validateSha256Digest(object.planDigest, context, 'planDigest');
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    phaseId: validateStableId(object.phaseId, context, 'phaseId'),
    title: validatePlanTitle(object.title, context, 'title'),
    description: validatePlanDescription(object.description, context, 'description'),
    labels: normalizeLabels(object.labels, context),
    sourceRefs: validatePlanArtifactRefs(
      object.sourceRefs,
      context,
      'sourceRefs',
      PLAN_FEATURE_SOURCE_REFS_MAX_COUNT,
    ),
    planDigest,
  };
}

export interface ValidatedCreateTaskInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: string[];
  readonly complexity: PlanComplexity | null;
  readonly acceptance: { criteria: string[] };
  readonly requirementsRefs: PlanArtifactRef[];
  readonly executionConfig: Record<string, unknown>;
  readonly configSource: string;
  readonly configSourceKey: string | null;
}

/** Task 成员业务/策略字段（F-005 创建与 F-008 替换共用；不含归属字段）。 */
const PLAN_TASK_MEMBER_KEYS = [
  'id',
  'title',
  'description',
  'labels',
  'complexity',
  'acceptance',
  'requirementsRefs',
  'executionConfig',
  'configSource',
  'configSourceKey',
] as const;

export interface ValidatedPlanTaskMemberFields {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: string[];
  readonly complexity: PlanComplexity | null;
  readonly acceptance: { criteria: string[] };
  readonly requirementsRefs: PlanArtifactRef[];
  readonly executionConfig: Record<string, unknown>;
  readonly configSource: string;
  readonly configSourceKey: string | null;
}

/**
 * Task 成员字段共用校验（F-002 创建输入与 F-008 替换成员同一规则；严格未知键
 * 拒绝，策略副本仅校验「普通 JSON 对象且有界」，完整语义由 F-003 应用层校验）。
 * extraKeys 允许创建面附加归属字段（projectId/featureId），替换面不传。
 */
function validatePlanTaskMemberFields(
  object: Record<string, unknown>,
  context: ValidationContext,
  fieldPrefix: string,
  extraKeys: readonly string[] = [],
): ValidatedPlanTaskMemberFields {
  rejectUnknownKeys(
    object,
    extraKeys.length > 0 ? [...PLAN_TASK_MEMBER_KEYS, ...extraKeys] : PLAN_TASK_MEMBER_KEYS,
    context,
    fieldPrefix,
  );
  const field = (name: string): string => `${fieldPrefix}.${name}`;

  const complexityValue = object.complexity;
  let complexity: PlanComplexity | null = null;
  if (complexityValue !== undefined && complexityValue !== null) {
    if (
      typeof complexityValue !== 'string' ||
      !TASK_COMPLEXITY_VALUES.includes(complexityValue as PlanComplexity)
    ) {
      throw validationError(
        context,
        field('complexity'),
        `必须是 ${TASK_COMPLEXITY_VALUES.join(' / ')} 或 null/省略（复用配置复杂度取值）`,
        complexityValue,
      );
    }
    complexity = complexityValue as PlanComplexity;
  }

  const executionConfigValue = object.executionConfig;
  if (!isPlainObject(executionConfigValue)) {
    throw validationError(
      context,
      field('executionConfig'),
      '必须是普通 JSON 对象（完整策略副本；完整策略语义由应用层校验）',
      executionConfigValue,
    );
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(executionConfigValue), 'utf8');
  if (serializedBytes > EXECUTION_CONFIG_MAX_BYTES) {
    throw validationError(
      context,
      field('executionConfig'),
      `序列化后不得超过 ${EXECUTION_CONFIG_MAX_BYTES} 字节（实际 ${serializedBytes}）`,
    );
  }

  const configSourceKey = object.configSourceKey;
  return {
    id: validateStableId(object.id, context, field('id')),
    title: validatePlanTitle(object.title, context, field('title')),
    description: validatePlanDescription(object.description, context, field('description')),
    labels: normalizeLabels(object.labels, context, field('labels')),
    complexity,
    acceptance: validatePlanAcceptance(object.acceptance, context, field('acceptance')),
    requirementsRefs: validatePlanArtifactRefs(
      object.requirementsRefs,
      context,
      field('requirementsRefs'),
      PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT,
    ),
    executionConfig: executionConfigValue,
    configSource: requireNonEmptyString(object.configSource, context, field('configSource')).trim(),
    configSourceKey:
      configSourceKey === undefined || configSourceKey === null
        ? null
        : requireNonEmptyString(configSourceKey, context, field('configSourceKey')).trim(),
  };
}

export function validateCreateTaskInput(value: unknown, operation: string): ValidatedCreateTaskInput {
  const context: ValidationContext = { operation, entity: { type: 'task' } };
  const object = requirePlainObject(value, context, 'input');
  const member = validatePlanTaskMemberFields(object, context, 'input', ['projectId', 'featureId']);
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    featureId: validateStableId(object.featureId, context, 'featureId'),
    ...member,
  };
}

export interface ValidatedCreateTaskDependencyInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly dependsOnId: string;
}

export function validateCreateTaskDependencyInput(
  value: unknown,
  operation: string,
): ValidatedCreateTaskDependencyInput {
  const context: ValidationContext = { operation, entity: { type: 'task_dependency' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, CREATE_TASK_DEPENDENCY_KEYS, context, 'input');
  const valid: ValidatedCreateTaskDependencyInput = {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    featureId: validateStableId(object.featureId, context, 'featureId'),
    taskId: validateStableId(object.taskId, context, 'taskId'),
    dependsOnId: validateStableId(object.dependsOnId, context, 'dependsOnId'),
  };
  if (valid.taskId === valid.dependsOnId) {
    throw new StorageError(
      'validation',
      operation,
      `${operation}: dependsOnId 自依赖不被允许`,
      {
        entity: { type: 'task', id: valid.taskId },
        details: {
          field: 'dependsOnId',
          reason: '自依赖不被允许',
          taskId: valid.taskId,
          dependsOnTaskId: valid.dependsOnId,
        },
      },
    );
  }
  return valid;
}

/* ------------------------------------------------------------------ *
 * F-008 实质计划修订：计划快照读取与整体替换输入（同一写事务内使用）
 *
 * 修订在 Feature 聚合的同一写事务内整体替换计划成员与依赖边（一次 CAS
 * 一次递增）；既有 Task 按稳定 ID 保留身份与既有策略副本（不因当前默认
 * 配置或 complexity 编辑自动更换 executionConfig），仅新 Task 携带创建时
 * 选定的策略副本。替换原语以库内既有成员身份为准确划分保留/新建/移除。
 * ------------------------------------------------------------------ */

/** 同一事务内读取的 Feature 计划快照（Feature + 全部 Task + 全部依赖边）。 */
export interface FeaturePlanSnapshot {
  readonly feature: FeatureRecord;
  readonly tasks: readonly TaskRecord[];
  readonly dependencies: readonly TaskDependencyRecord[];
}

/** 替换后的 Feature 计划（含保留/新建/移除成员分类结果）。 */
export interface FeaturePlanReplaceResult {
  readonly feature: FeatureRecord;
  /** 替换后的最终 Task 成员（id 升序）。 */
  readonly tasks: readonly TaskRecord[];
  /** 保留成员（既有稳定身份，策略副本未变）的稳定 ID（输入序）。 */
  readonly keptTaskIds: readonly string[];
  /** 新建成员（按创建策略规则携带策略副本）的稳定 ID（输入序）。 */
  readonly createdTaskIds: readonly string[];
  /** 被本次修订移除的既有成员稳定 ID（快照序）。 */
  readonly removedTaskIds: readonly string[];
}

export interface ValidatedReplaceFeaturePlanInput {
  readonly projectId: string;
  readonly featureId: string;
  /** Feature 聚合当前 revision（唯一 CAS 权威；≥1 安全整数）。 */
  readonly expectedRevision: number;
  readonly feature: {
    readonly title: string;
    readonly description: string | null;
    readonly labels: string[];
    readonly sourceRefs: PlanArtifactRef[];
    readonly planDigest: string | null;
    /** 修订后计划审批状态（由批准有效性纯规则决定；仅限冻结枚举）。 */
    readonly planStatus: FeaturePlanStatus;
  };
  readonly tasks: ValidatedPlanTaskMemberFields[];
  readonly dependencies: { readonly taskId: string; readonly dependsOnId: string }[];
}

const REPLACE_FEATURE_PLAN_KEYS = [
  'projectId',
  'featureId',
  'expectedRevision',
  'feature',
  'tasks',
  'dependencies',
] as const;
const REPLACE_FEATURE_PLAN_FEATURE_KEYS = [
  'title',
  'description',
  'labels',
  'sourceRefs',
  'planDigest',
  'planStatus',
] as const;
const REPLACE_FEATURE_PLAN_DEPENDENCY_KEYS = ['taskId', 'dependsOnId'] as const;

/**
 * F-008：整体替换输入校验（unknown → 已校验形态；失败零副作用）。严格未知键
 * 拒绝：成员 mode/身份状态/批准/revision 等不经输入面（保留/新建由库内既有
 * 成员身仈权威划分）；重复 Task ID、自依赖、重复边、指向最终集合外的边一律
 * 拒绝；成员数/边数复用计划边界常量（防御纵深，应用层纯校验已先行）。
 */
export function validateReplaceFeaturePlanInput(
  value: unknown,
  operation: string,
): ValidatedReplaceFeaturePlanInput {
  const context: ValidationContext = { operation, entity: { type: 'feature' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, REPLACE_FEATURE_PLAN_KEYS, context, 'input');

  const expectedRevision = object.expectedRevision;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    throw validationError(context, 'expectedRevision', '必须是 ≥1 的安全整数', expectedRevision);
  }

  const featureObject = requirePlainObject(object.feature, context, 'feature');
  rejectUnknownKeys(featureObject, REPLACE_FEATURE_PLAN_FEATURE_KEYS, context, 'feature');
  const planStatus = featureObject.planStatus;
  if (
    typeof planStatus !== 'string' ||
    !(FEATURE_PLAN_STATUSES as readonly string[]).includes(planStatus)
  ) {
    throw validationError(
      context,
      'feature.planStatus',
      `必须是 ${FEATURE_PLAN_STATUSES.join(' / ')}`,
      planStatus,
    );
  }
  const feature = {
    title: validatePlanTitle(featureObject.title, context, 'feature.title'),
    description: validatePlanDescription(featureObject.description, context, 'feature.description'),
    labels: normalizeLabels(featureObject.labels, context, 'feature.labels'),
    sourceRefs: validatePlanArtifactRefs(
      featureObject.sourceRefs,
      context,
      'feature.sourceRefs',
      PLAN_FEATURE_SOURCE_REFS_MAX_COUNT,
    ),
    planDigest:
      featureObject.planDigest === undefined || featureObject.planDigest === null
        ? null
        : validateSha256Digest(featureObject.planDigest, context, 'feature.planDigest'),
    planStatus: planStatus as FeaturePlanStatus,
  };

  if (!Array.isArray(object.tasks)) {
    throw validationError(context, 'tasks', '必须是 Task 成员数组（最终成员全集）', object.tasks);
  }
  if (object.tasks.length > PLAN_TASKS_MAX_COUNT) {
    throw validationError(
      context,
      'tasks',
      `最终成员数不得超过 ${PLAN_TASKS_MAX_COUNT}（实际 ${object.tasks.length}）`,
    );
  }
  const taskContext: ValidationContext = { operation, entity: { type: 'task' } };
  const tasks: ValidatedPlanTaskMemberFields[] = [];
  const taskIds = new Set<string>();
  for (const [index, taskValue] of object.tasks.entries()) {
    const taskObject = requirePlainObject(taskValue, taskContext, `tasks[${index}]`);
    const member = validatePlanTaskMemberFields(taskObject, taskContext, `tasks[${index}]`);
    if (taskIds.has(member.id)) {
      throw new StorageError(
        'validation',
        operation,
        `${operation}: tasks[${index}].id 最终成员内重复 Task ID`,
        {
          entity: { type: 'task', id: member.id },
          details: { field: `tasks[${index}].id`, reason: '重复 Task ID', taskId: member.id },
        },
      );
    }
    taskIds.add(member.id);
    tasks.push(member);
  }

  if (!Array.isArray(object.dependencies)) {
    throw validationError(
      context,
      'dependencies',
      '必须是依赖边数组（最终边全集）',
      object.dependencies,
    );
  }
  if (object.dependencies.length > PLAN_DEPENDENCY_EDGES_MAX_COUNT) {
    throw validationError(
      context,
      'dependencies',
      `最终边数不得超过 ${PLAN_DEPENDENCY_EDGES_MAX_COUNT}（实际 ${object.dependencies.length}）`,
    );
  }
  const dependencies: { taskId: string; dependsOnId: string }[] = [];
  const edgeKeys = new Set<string>();
  for (const [index, edgeValue] of object.dependencies.entries()) {
    const edgeObject = requirePlainObject(edgeValue, context, `dependencies[${index}]`);
    rejectUnknownKeys(
      edgeObject,
      REPLACE_FEATURE_PLAN_DEPENDENCY_KEYS,
      context,
      `dependencies[${index}]`,
    );
    const taskId = validateStableId(edgeObject.taskId, context, `dependencies[${index}].taskId`);
    const dependsOnId = validateStableId(
      edgeObject.dependsOnId,
      context,
      `dependencies[${index}].dependsOnId`,
    );
    if (taskId === dependsOnId) {
      throw new StorageError(
        'validation',
        operation,
        `${operation}: dependencies[${index}].dependsOnId 自依赖不被允许`,
        {
          entity: { type: 'task', id: taskId },
          details: {
            field: `dependencies[${index}].dependsOnId`,
            reason: '自依赖不被允许',
            taskId,
            dependsOnTaskId: dependsOnId,
          },
        },
      );
    }
    if (!taskIds.has(taskId)) {
      throw new StorageError(
        'validation',
        operation,
        `${operation}: dependencies[${index}].taskId 边端点不在最终成员集合内`,
        {
          entity: { type: 'task', id: taskId },
          details: { field: `dependencies[${index}].taskId`, reason: '边端点不在最终成员集合内', taskId },
        },
      );
    }
    if (!taskIds.has(dependsOnId)) {
      throw new StorageError(
        'validation',
        operation,
        `${operation}: dependencies[${index}].dependsOnId 边端点不在最终成员集合内`,
        {
          entity: { type: 'task', id: dependsOnId },
          details: {
            field: `dependencies[${index}].dependsOnId`,
            reason: '边端点不在最终成员集合内',
            taskId,
            dependsOnTaskId: dependsOnId,
          },
        },
      );
    }
    const edgeKey = `${taskId}\u0000${dependsOnId}`;
    if (edgeKeys.has(edgeKey)) {
      throw new StorageError(
        'validation',
        operation,
        `${operation}: dependencies[${index}] 重复依赖边`,
        {
          entity: { type: 'task_dependency' },
          details: {
            field: `dependencies[${index}]`,
            reason: '重复依赖边',
            taskId,
            dependsOnTaskId: dependsOnId,
          },
        },
      );
    }
    edgeKeys.add(edgeKey);
    dependencies.push({ taskId, dependsOnId });
  }

  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    featureId: validateStableId(object.featureId, context, 'featureId'),
    expectedRevision,
    feature,
    tasks,
    dependencies,
  };
}

/* ------------------------------------------------------------------ *
 * 事件追加契约（F-004：Phase 创建事件；后续计划事件随对应功能扩展白名单）
 *
 * 同步事务原语（供 CommandTransaction.appendPlanEvent 使用）：payload 只允许
 * 受控脱敏形状，写入行必须能被 ports/events.ts 公开映射读取（白名单同源）。
 * 事件写入由命令用例在同一事务内与业务行、回执组合（F-002 不预支进插入原语）。
 * ------------------------------------------------------------------ */

/** F-004：Phase 创建事件（仅命令路径创建成功写入；脱敏 payload 恒为 {created:true}）。 */
export const PHASE_CREATED_EVENT_TYPE = 'phase.created';

/**
 * F-005：Feature 计划导入事件（仅命令路径导入成功写入；脱敏 payload 恒为
 * {imported:true}，聚合为导入创建的 Feature 自身，aggregateRevision=创建 revision）。
 */
export const FEATURE_PLAN_IMPORTED_EVENT_TYPE = 'feature.plan.imported';

/**
 * F-007：纯标签 CAS 编辑事件（仅命令路径编辑成功写入；脱敏 payload 恒为
 * {labelsUpdated:true}，聚合为目标实体自身，aggregateRevision=编辑后 revision）。
 * 标签是元数据：事件不携带标签正文/计划语义。
 */
export const PHASE_LABELS_UPDATED_EVENT_TYPE = 'phase.labels.updated';
export const FEATURE_LABELS_UPDATED_EVENT_TYPE = 'feature.labels.updated';
export const TASK_LABELS_UPDATED_EVENT_TYPE = 'task.labels.updated';

/**
 * F-008：实质计划修订事件（仅命令路径修订成功写入；脱敏 payload 恒为
 * {revised:true}，聚合为目标 Feature 自身，aggregateRevision=修订后聚合
 * revision）。不携带计划正文/成员变更明细/策略副本/批准语义。
 */
export const FEATURE_PLAN_REVISED_EVENT_TYPE = 'feature.plan.revised';

/**
 * P03-2 / F-001：Task 策略副本 CAS 编辑事件（仅命令路径编辑成功写入；脱敏
 * payload 恒为 {strategyUpdated:true}，聚合为目标 Task 自身，
 * aggregateRevision=编辑后 Task revision）。不携带策略副本正文/凭据引用/
 * 批准或执行语义。
 */
export const TASK_STRATEGY_UPDATED_EVENT_TYPE = 'task.strategy.updated';

/**
 * P03-2 / F-002：计划批准事件（仅命令路径批准成功写入；脱敏 payload 恒为
 * {approved:true}，聚合为目标 Feature 自身，aggregateRevision=决策后 Feature
 * 聚合 revision）。不携带计划正文/决策人身份/原因/执行语义。
 */
export const FEATURE_PLAN_APPROVED_EVENT_TYPE = 'feature.plan.approved';

/**
 * P03-2 / F-002：计划拒绝事件（仅命令路径拒绝成功写入；脱敏 payload 恒为
 * {rejected:true}，聚合为目标 Feature 自身，aggregateRevision=决策后 Feature
 * 聚合 revision）。不携带计划正文/决策人身份/原因/执行语义。
 */
export const FEATURE_PLAN_REJECTED_EVENT_TYPE = 'feature.plan.rejected';

/**
 * P03-2 / F-006：执行输入制品组准备完成事件（仅命令路径最终重核通过后写入；
 * 脱敏 payload 恒为 {prepared:true}，聚合为目标 Task 自身，aggregateRevision=
 * 最终重核时 Task revision）。不携带 snapshot/manifest/prompt 正文、策略副本、
 * 凭据引用或执行/启动语义（准备输入不是启动执行）。
 */
export const EXECUTION_INPUT_PREPARED_EVENT_TYPE = 'execution.input.prepared';

/** 计划域事件白名单（顺序即冻结顺序；白名单外不得进入公开事件流）。 */
export const PLAN_EVENT_TYPES = [
  PHASE_CREATED_EVENT_TYPE,
  FEATURE_PLAN_IMPORTED_EVENT_TYPE,
  PHASE_LABELS_UPDATED_EVENT_TYPE,
  FEATURE_LABELS_UPDATED_EVENT_TYPE,
  TASK_LABELS_UPDATED_EVENT_TYPE,
  FEATURE_PLAN_REVISED_EVENT_TYPE,
  TASK_STRATEGY_UPDATED_EVENT_TYPE,
  FEATURE_PLAN_APPROVED_EVENT_TYPE,
  FEATURE_PLAN_REJECTED_EVENT_TYPE,
  EXECUTION_INPUT_PREPARED_EVENT_TYPE,
] as const;
export type PlanEventType = (typeof PLAN_EVENT_TYPES)[number];

export interface ValidatedPlanEventAppend {
  readonly projectId: string;
  readonly eventType: PlanEventType;
  /** phase.* 聚合恒为 'phase'；feature.* 恒为 'feature'；task.labels.updated 恒为 'task'。 */
  readonly aggregateType: 'phase' | 'feature' | 'task';
  readonly aggregateId: string;
  readonly aggregateRevision: number;
  /** 脱敏 payload（恒定形状：{created:true}/{imported:true}/{labelsUpdated:true}/{revised:true}）。 */
  readonly payload: Record<string, unknown>;
}

const PLAN_EVENT_APPEND_KEYS = [
  'projectId',
  'eventType',
  'aggregateType',
  'aggregateId',
  'aggregateRevision',
  'payload',
] as const;

/** 每类事件冻结的聚合类型与脱敏 payload 固定键/值。 */
interface PlanEventTypeSpec {
  readonly aggregateType: 'phase' | 'feature' | 'task';
  readonly payloadKey:
    | 'created'
    | 'imported'
    | 'labelsUpdated'
    | 'revised'
    | 'strategyUpdated'
    | 'approved'
    | 'rejected'
    | 'prepared';
}

const PLAN_EVENT_TYPE_SPECS: Readonly<Record<PlanEventType, PlanEventTypeSpec>> = Object.freeze({
  [PHASE_CREATED_EVENT_TYPE]: Object.freeze({ aggregateType: 'phase', payloadKey: 'created' }),
  [FEATURE_PLAN_IMPORTED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    payloadKey: 'imported',
  }),
  [PHASE_LABELS_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'phase',
    payloadKey: 'labelsUpdated',
  }),
  [FEATURE_LABELS_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    payloadKey: 'labelsUpdated',
  }),
  [TASK_LABELS_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'task',
    payloadKey: 'labelsUpdated',
  }),
  [FEATURE_PLAN_REVISED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    payloadKey: 'revised',
  }),
  [TASK_STRATEGY_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'task',
    payloadKey: 'strategyUpdated',
  }),
  [FEATURE_PLAN_APPROVED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    payloadKey: 'approved',
  }),
  [FEATURE_PLAN_REJECTED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    payloadKey: 'rejected',
  }),
  [EXECUTION_INPUT_PREPARED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'task',
    payloadKey: 'prepared',
  }),
});

export function validatePlanEventAppend(value: unknown, operation: string): ValidatedPlanEventAppend {
  const baseContext: ValidationContext = { operation, entity: { type: 'phase' } };
  const object = requirePlainObject(value, baseContext, 'input');
  rejectUnknownKeys(object, PLAN_EVENT_APPEND_KEYS, baseContext, 'input');
  const eventTypeValue = object.eventType;
  if (
    typeof eventTypeValue !== 'string' ||
    !(PLAN_EVENT_TYPES as readonly string[]).includes(eventTypeValue)
  ) {
    throw validationError(baseContext, 'eventType', `必须是 ${PLAN_EVENT_TYPES.join(' / ')}`, eventTypeValue);
  }
  const eventType = eventTypeValue as PlanEventType;
  const spec = PLAN_EVENT_TYPE_SPECS[eventType];
  const context: ValidationContext = { operation, entity: { type: spec.aggregateType } };
  if (object.aggregateType !== spec.aggregateType) {
    throw validationError(context, 'aggregateType', `必须是 ${spec.aggregateType}`, object.aggregateType);
  }
  const aggregateRevision = object.aggregateRevision;
  if (
    typeof aggregateRevision !== 'number' ||
    !Number.isSafeInteger(aggregateRevision) ||
    aggregateRevision < 1
  ) {
    throw validationError(context, 'aggregateRevision', '必须是 ≥1 的安全整数', aggregateRevision);
  }
  const payload = requirePlainObject(object.payload, context, 'payload');
  rejectUnknownKeys(payload, [spec.payloadKey], context, 'payload');
  if (payload[spec.payloadKey] !== true) {
    throw validationError(
      context,
      `payload.${spec.payloadKey}`,
      `必须是 true（脱敏事件固定形状）`,
      payload[spec.payloadKey],
    );
  }
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    eventType,
    aggregateType: spec.aggregateType,
    aggregateId: validateStableId(object.aggregateId, context, 'aggregateId'),
    aggregateRevision,
    payload:
      spec.payloadKey === 'created'
        ? { created: true }
        : spec.payloadKey === 'imported'
          ? { imported: true }
          : spec.payloadKey === 'labelsUpdated'
            ? { labelsUpdated: true }
            : spec.payloadKey === 'revised'
              ? { revised: true }
              : spec.payloadKey === 'strategyUpdated'
                ? { strategyUpdated: true }
                : spec.payloadKey === 'approved'
                  ? { approved: true }
                  : spec.payloadKey === 'rejected'
                    ? { rejected: true }
                    : { prepared: true },
  };
}

/* ------------------------------------------------------------------ *
 * 事务内环复核（供适配器原语复用；与 F-001 纯校验同一 DFS）
 * ------------------------------------------------------------------ */

/**
 * 同 Feature 依赖边集合的环检测：加载库内既有边 + 新边后复核无环。
 * 返回环路径（首尾相同）或 undefined；DDL 无法表达环约束（P03-1 契约 §3），
 * 由存储原语在事务内调用本函数完成应用层校验。
 */
export function assertNoDependencyCycle(
  edges: readonly { readonly taskId: string; readonly dependsOnId: string }[],
  operation: string,
  entity: StorageEntityRef,
): void {
  const nodes = new Map<string, string[]>();
  for (const edge of edges) {
    const list = nodes.get(edge.taskId) ?? [];
    list.push(edge.dependsOnId);
    nodes.set(edge.taskId, list);
    if (!nodes.has(edge.dependsOnId)) {
      nodes.set(edge.dependsOnId, []);
    }
  }
  const cycle = detectPlanDependencyCycle(
    [...nodes.entries()].map(([id, dependsOn]) => ({ id, dependsOn })),
  );
  if (cycle !== undefined) {
    throw new StorageError('validation', operation, `${operation}: 依赖存在环（环路径见 details.cycle）`, {
      entity,
      details: { field: 'dependencies', reason: 'cycle', cycle },
    });
  }
}
