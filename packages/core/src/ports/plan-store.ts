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
  PLAN_FEATURE_SOURCE_REFS_MAX_COUNT,
  PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT,
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
const CREATE_TASK_KEYS = [
  'projectId',
  'featureId',
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
const CREATE_TASK_DEPENDENCY_KEYS = ['projectId', 'featureId', 'taskId', 'dependsOnId'] as const;

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

export function validateCreateTaskInput(value: unknown, operation: string): ValidatedCreateTaskInput {
  const context: ValidationContext = { operation, entity: { type: 'task' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, CREATE_TASK_KEYS, context, 'input');

  const complexityValue = object.complexity;
  let complexity: PlanComplexity | null = null;
  if (complexityValue !== undefined && complexityValue !== null) {
    if (
      typeof complexityValue !== 'string' ||
      !TASK_COMPLEXITY_VALUES.includes(complexityValue as PlanComplexity)
    ) {
      throw validationError(
        context,
        'complexity',
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
    featureId: validateStableId(object.featureId, context, 'featureId'),
    id: validateStableId(object.id, context, 'id'),
    title: validatePlanTitle(object.title, context, 'title'),
    description: validatePlanDescription(object.description, context, 'description'),
    labels: normalizeLabels(object.labels, context),
    complexity,
    acceptance: validatePlanAcceptance(object.acceptance, context, 'acceptance'),
    requirementsRefs: validatePlanArtifactRefs(
      object.requirementsRefs,
      context,
      'requirementsRefs',
      PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT,
    ),
    executionConfig: executionConfigValue,
    configSource: requireNonEmptyString(object.configSource, context, 'configSource').trim(),
    configSourceKey:
      configSourceKey === undefined || configSourceKey === null
        ? null
        : requireNonEmptyString(configSourceKey, context, 'configSourceKey').trim(),
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

/** 计划域事件白名单（顺序即冻结顺序；白名单外不得进入公开事件流）。 */
export const PLAN_EVENT_TYPES = [PHASE_CREATED_EVENT_TYPE, FEATURE_PLAN_IMPORTED_EVENT_TYPE] as const;
export type PlanEventType = (typeof PLAN_EVENT_TYPES)[number];

export interface ValidatedPlanEventAppend {
  readonly projectId: string;
  readonly eventType: PlanEventType;
  /** phase.created 聚合恒为 'phase'；feature.plan.imported 聚合恒为 'feature'。 */
  readonly aggregateType: 'phase' | 'feature';
  readonly aggregateId: string;
  readonly aggregateRevision: number;
  /** 脱敏 payload（phase.created 恒 {created:true}；feature.plan.imported 恒 {imported:true}）。 */
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
  readonly aggregateType: 'phase' | 'feature';
  readonly payloadKey: 'created' | 'imported';
}

const PLAN_EVENT_TYPE_SPECS: Readonly<Record<PlanEventType, PlanEventTypeSpec>> = Object.freeze({
  [PHASE_CREATED_EVENT_TYPE]: Object.freeze({ aggregateType: 'phase', payloadKey: 'created' }),
  [FEATURE_PLAN_IMPORTED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    payloadKey: 'imported',
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
    payload: spec.payloadKey === 'created' ? { created: true } : { imported: true },
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
