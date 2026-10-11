/**
 * F-001 单 Feature 草稿计划输入契约（ports 契约层：类型、常量、纯校验与纯摘要函数）。
 *
 * 设计依据：core-design/02 §8（Project → Phase → Feature → Task 两层 DAG；计划修改时
 * 校验成员唯一、缺失引用、自依赖和环）、§10（Task 不能只用 requirements_ref 充当名称，
 * description 不替代结构化验收与依赖；labels 默认空数组且不参与计划语义）、
 * core-design/11 §4（task_dependencies 两端为同 Feature Task、UNIQUE(feature_id,
 * task_id,depends_on_id)、无环；features.plan_digest 可空摘要）。
 * 实施契约：docs/p03-1-plan-import-contract.md（P03-1 / F-001 冻结，含边界数值请求核对）。
 *
 * 契约要点：
 * - 本模块只做**纯结构校验**（无 I/O、无时钟、无数据库、无模型调用）：输入是
 *   unknown（外部 JSON），输出是规范化业务计划与确定性 planDigest；归属
 *   （projectId/phaseId/featureId）与引用是否真实存在由 F-005 的导入事务提交重核，
 *   本模块不查、不假装查过；
 * - 计划 payload **只有业务内容**：expectedRevision/revision/时间戳/策略来源说明等
 *   信封与聚合字段一律按未知键拒绝（CAS 唯一权威来源是命令信封，不在 payload 与
 *   信封建立两个 CAS 权威来源）；
 * - 复用既有公共端口规则：稳定 ID（validateStableId）、标签规范化（normalizeLabels
 *   及其长度/数量上限）、结构化错误（StorageError kind='validation'，details 只含
 *   field/reason/节点定位/receivedType，不回显输入正文）、描述规则（与项目描述同
 *   语义：省略/null/全空白归一为 null，长度上限 DESCRIPTION_MAX_LENGTH）、
 *   complexity 复用配置校验的 ModelComplexity 取值；
 * - DAG 校验：重复 ID、缺依赖、跨 Feature 依赖（调用方提供 externalTasks 解析上下文
 *   时）、自依赖、重复依赖、环，全部返回带字段（tasks[i].dependsOn[j] 等）或节点
 *   定位（details.taskId/dependsOnTaskId/cycle）的错误；
 * - 无 Task 的计划可校验为草稿（executable=false 明确不可执行）；校验通过不代表
 *   已批准或可执行，本任务不生成 Run、审批或模型调用。
 */
import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';
import type { StorageEntityRef } from './errors.js';
import type { ModelComplexity } from './settings-schema.js';
import {
  DESCRIPTION_MAX_LENGTH,
  describeValueType,
  normalizeLabels,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateStableId,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 版本与边界常量（实施契约值，记录于 docs/p03-1-plan-import-contract.md）
 * ------------------------------------------------------------------ */

/** 本版本 Core 唯一支持的计划 payload 结构版本；未知/更高版本拒绝，不静默降级。 */
export const FEATURE_PLAN_SCHEMA_VERSION = 1;

/**
 * planDigest 的领域前缀：把摘要锚定到「单 Feature 业务计划 v1」语义，
 * 防止不同领域/版本的规范化串意外碰撞。
 */
export const PLAN_DIGEST_DOMAIN = 'shiploop:feature-plan-business:v1';

/** Feature/Task 标题长度上限（Unicode 码点；与项目展示名同量级的实施契约值）。 */
export const PLAN_TITLE_MAX_LENGTH = 200;
/** 单计划任务数量上限（含 0：空草稿合法）。 */
export const PLAN_TASKS_MAX_COUNT = 100;
/** 单计划依赖边总数上限（所有任务 dependsOn 之和，去重前按输入计数）。 */
export const PLAN_DEPENDENCY_EDGES_MAX_COUNT = 200;
/** 单 Task 验收条目数量上限。 */
export const PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT = 32;
/** 单条验收正文长度上限（Unicode 码点）。 */
export const PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH = 2000;
/** 单 Task 需求/验收引用数量上限（去重后）。 */
export const PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT = 8;
/** Feature 级来源引用数量上限（去重后）。 */
export const PLAN_FEATURE_SOURCE_REFS_MAX_COUNT = 16;

/** 计划任务复杂度：复用配置校验（settings-schema）的 ModelComplexity 取值。 */
export type PlanComplexity = ModelComplexity;

const PLAN_COMPLEXITY_VALUES: readonly PlanComplexity[] = ['low', 'medium', 'high'];

const PLAN_PAYLOAD_KEYS = ['schemaVersion', 'feature', 'tasks'] as const;
const PLAN_FEATURE_KEYS = ['title', 'description', 'labels', 'sourceRefs'] as const;
const PLAN_TASK_KEYS = [
  'id',
  'title',
  'description',
  'labels',
  'complexity',
  'acceptance',
  'requirementsRefs',
  'dependsOn',
] as const;
const PLAN_ACCEPTANCE_KEYS = ['criteria'] as const;
const PLAN_REF_KEYS = ['artifactId', 'contentHash'] as const;

const PLAN_DEFAULT_OPERATION = 'FeaturePlan.validate';

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/**
 * 计划引用：身份级制品引用。artifactId 必填稳定 ID；contentHash 可选（64 位小写
 * 十六进制），携带时把引用绑定到具体内容版本。引用只描述身份，不内联正文，
 * 是否真实存在/可用由导入事务重核（F-005）。
 */
export interface PlanArtifactRef {
  readonly artifactId: string;
  readonly contentHash?: string;
}

export interface ValidatedFeaturePlanTask {
  readonly id: string;
  readonly title: string;
  /** 省略/null/全空白归一为 null；原文保留（Markdown/Unicode 不转写）。 */
  readonly description: string | null;
  /** 规范化标签（元数据；不参与 planDigest）。 */
  readonly labels: readonly string[];
  /** 省略/null 归一为 null；取值复用配置复杂度 low/medium/high。 */
  readonly complexity: PlanComplexity | null;
  /** 结构化验收：至少一条非空条目，保持输入顺序（有序清单）。 */
  readonly acceptance: { readonly criteria: readonly string[] };
  /** 需求/验收引用；缺失归一为空数组，排序去重后输出。 */
  readonly requirementsRefs: readonly PlanArtifactRef[];
  /** 同 Feature 依赖目标（已解析、去重并排序）。 */
  readonly dependsOn: readonly string[];
}

/** 校验后的规范化单 Feature 草稿计划（含确定性业务摘要）。 */
export interface ValidatedFeaturePlan {
  readonly schemaVersion: typeof FEATURE_PLAN_SCHEMA_VERSION;
  readonly feature: {
    readonly title: string;
    readonly description: string | null;
    readonly labels: readonly string[];
    readonly sourceRefs: readonly PlanArtifactRef[];
  };
  /** 按 id 稳定排序的任务清单。 */
  readonly tasks: readonly ValidatedFeaturePlanTask[];
  readonly taskCount: number;
  readonly dependencyEdgeCount: number;
  /**
   * 结构性可执行前提：至少一个 Task 且同 Feature DAG 校验通过。false 表示零 Task
   * 草稿明确不可执行；true 不代表已批准、配置就绪或可启动 Run（审批与执行不在
   * 本契约内）。
   */
  readonly executable: boolean;
  /** 业务计划摘要（64 位小写十六进制 SHA-256；不是 CAS 依据）。 */
  readonly planDigest: string;
}

export interface FeaturePlanValidationOptions {
  /** 发生校验的操作名（写入 StorageError.operation）；默认 'FeaturePlan.validate'。 */
  readonly operation?: string;
  /**
   * 跨 Feature 任务解析上下文（可选；taskId → featureId）。提供时，dependsOn 指向
   * 不在本计划内但命中该上下文的目标，按「跨 Feature 依赖」精确报错；未提供或未
   * 命中则按「缺依赖」报错。纯数据注入，不在本模块做任何 I/O。
   */
  readonly externalTasks?: ReadonlyMap<string, string>;
}

/* ------------------------------------------------------------------ *
 * 错误构造（脱敏：details 只含 field/reason/节点定位/receivedType）
 * ------------------------------------------------------------------ */

function planValidationContext(operation: string): ValidationContext {
  const entity: StorageEntityRef = { type: 'feature' };
  return { operation, entity };
}

function planError(
  context: ValidationContext,
  field: string,
  reason: string,
  extra?: Readonly<Record<string, unknown>>,
  received?: unknown,
): StorageError {
  const details: Record<string, unknown> = { field, reason, ...(extra ?? {}) };
  if (received !== undefined) {
    details.receivedType = describeValueType(received);
  }
  return new StorageError('validation', context.operation, `${context.operation}: ${field} ${reason}`, {
    entity: context.entity,
    details,
  });
}

function taskErrorContext(context: ValidationContext, taskId: string): ValidationContext {
  return { operation: context.operation, entity: { type: 'task', id: taskId } };
}

/* ------------------------------------------------------------------ *
 * 标量与共用规则
 * ------------------------------------------------------------------ */

/** 以 Unicode 码点计数（String.length 会把 emoji 记为 2）。 */
function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * 计划标题：非空字符串，trim 后有界（Feature 与 Task 共用）。
 * P03-1 / F-002 起导出供 plan-store（Phase/Feature/Task 存储端口）复用同一规则，
 * 不另立第二套标题校验。
 */
export function validatePlanTitle(value: unknown, context: ValidationContext, field: string): string {
  const title = requireNonEmptyString(value, context, field);
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw planError(context, field, '不允许为空或全空白', undefined, value);
  }
  if (codePointLength(trimmed) > PLAN_TITLE_MAX_LENGTH) {
    throw planError(
      context,
      field,
      `长度不得超过 ${PLAN_TITLE_MAX_LENGTH} 个字符（Unicode 码点）`,
      undefined,
      value,
    );
  }
  return trimmed;
}

/**
 * 计划描述（Feature/Task 共用）：省略（undefined）为未提供 → null；null 或全空白
 * 归一为 null（空描述是合法输入）；其余原文保留，长度 ≤ DESCRIPTION_MAX_LENGTH
 * （与项目描述同一上限与语义，不另立数值）。P03-1 / F-002 起导出供 plan-store 复用。
 */
export function validatePlanDescription(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw planError(context, field, '必须是字符串、null 或省略', undefined, value);
  }
  if (value.trim().length === 0) {
    return null;
  }
  if (codePointLength(value) > DESCRIPTION_MAX_LENGTH) {
    throw planError(
      context,
      field,
      `长度不得超过 ${DESCRIPTION_MAX_LENGTH} 个字符（Unicode 码点）`,
      undefined,
      value,
    );
  }
  return value;
}

/**
 * 引用清单校验与归一：undefined/null/[]（缺失的三种形态）一律归一为空数组，不报错
 * ——「已约定必需引用」的必需性由导入事务（F-005）重核；存在时必须是非空数组，
 * 每项是 { artifactId（稳定 ID）, contentHash?（64 位小写十六进制） }，完全相同的
 * 引用去重，输出按 (artifactId, contentHash) 排序（摘要顺序无关的基础）。
 * P03-1 / F-002 起导出供 plan-store 复用（存储层不重复实现引用形态规则）。
 */
export function validatePlanArtifactRefs(
  value: unknown,
  context: ValidationContext,
  field: string,
  maxCount: number,
): PlanArtifactRef[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw planError(context, field, '必须是引用对象数组', undefined, value);
  }
  if (value.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const refs: PlanArtifactRef[] = [];
  for (const [index, item] of value.entries()) {
    const itemField = `${field}[${index}]`;
    const object = requirePlainObject(item, context, itemField);
    rejectUnknownKeys(object, PLAN_REF_KEYS, context, itemField);
    const artifactId = validateStableId(object.artifactId, context, `${itemField}.artifactId`);
    const contentHash =
      object.contentHash === undefined
        ? undefined
        : requireSha256(object.contentHash, context, `${itemField}.contentHash`);
    const dedupeKey = contentHash === undefined ? artifactId : `${artifactId}@${contentHash}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      refs.push(contentHash === undefined ? { artifactId } : { artifactId, contentHash });
    }
  }
  if (refs.length > maxCount) {
    throw planError(context, field, `引用数量不得超过 ${maxCount} 个（去重后）`);
  }
  refs.sort((left, right) => {
    if (left.artifactId !== right.artifactId) {
      return left.artifactId < right.artifactId ? -1 : 1;
    }
    const leftHash = left.contentHash ?? '';
    const rightHash = right.contentHash ?? '';
    return leftHash === rightHash ? 0 : leftHash < rightHash ? -1 : 1;
  });
  return refs;
}

function requireSha256(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw planError(context, field, '必须是 64 位小写十六进制 SHA-256 摘要', undefined, value);
  }
  return value;
}

/**
 * 结构化验收：对象只含 criteria；≥1 条；条目非空、trim 后保留、有条数与长度上限。
 * P03-1 / F-002 起导出供 plan-store 复用（持久化验收与纯校验同形）。
 */
export function validatePlanAcceptance(
  value: unknown,
  context: ValidationContext,
  field: string,
): { criteria: string[] } {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, PLAN_ACCEPTANCE_KEYS, context, field);
  const criteria = object.criteria;
  if (!Array.isArray(criteria)) {
    throw planError(context, `${field}.criteria`, '必须是非空字符串数组（结构化验收不可缺省）', undefined, criteria);
  }
  if (criteria.length === 0) {
    throw planError(context, `${field}.criteria`, '至少包含一条验收条目（description 或引用不能替代完整验收）');
  }
  if (criteria.length > PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT) {
    throw planError(
      context,
      `${field}.criteria`,
      `验收条目数量不得超过 ${PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT} 条`,
    );
  }
  const normalized: string[] = [];
  for (const [index, statement] of criteria.entries()) {
    const statementField = `${field}.criteria[${index}]`;
    const text = requireNonEmptyString(statement, context, statementField);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw planError(context, statementField, '验收条目不允许为空或全空白', undefined, statement);
    }
    if (codePointLength(trimmed) > PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH) {
      throw planError(
        context,
        statementField,
        `验收条目长度不得超过 ${PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH} 个字符（Unicode 码点）`,
      );
    }
    normalized.push(trimmed);
  }
  return { criteria: normalized };
}

/* ------------------------------------------------------------------ *
 * 主校验入口
 * ------------------------------------------------------------------ */

/**
 * 校验单 Feature 草稿计划输入（unknown → 规范化业务计划 + planDigest）。
 *
 * 校验顺序（首错即抛，确定性）：顶层结构与版本 → Feature 元数据 → 任务结构
 * （含数量边界）→ 依赖边总数边界 → 重复 ID → 逐边语义（自依赖/重复依赖/缺依赖/
 * 跨 Feature 依赖）→ 环检测。
 */
export function validateFeaturePlanInput(
  value: unknown,
  options: FeaturePlanValidationOptions = {},
): ValidatedFeaturePlan {
  const operation = options.operation ?? PLAN_DEFAULT_OPERATION;
  const context = planValidationContext(operation);

  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, PLAN_PAYLOAD_KEYS, context, 'input');

  if (object.schemaVersion !== FEATURE_PLAN_SCHEMA_VERSION) {
    throw planError(
      context,
      'schemaVersion',
      `必须是 ${FEATURE_PLAN_SCHEMA_VERSION}（当前唯一支持的计划结构版本，未知/更高版本拒绝，不静默降级）`,
      undefined,
      object.schemaVersion,
    );
  }

  const featureObject = requirePlainObject(object.feature, context, 'feature');
  rejectUnknownKeys(featureObject, PLAN_FEATURE_KEYS, context, 'feature');
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
  };

  const tasksInput = object.tasks === undefined ? [] : object.tasks;
  if (!Array.isArray(tasksInput)) {
    throw planError(context, 'tasks', '必须是任务对象数组', undefined, object.tasks);
  }
  if (tasksInput.length > PLAN_TASKS_MAX_COUNT) {
    throw planError(context, 'tasks', `任务数量不得超过 ${PLAN_TASKS_MAX_COUNT} 个`);
  }

  interface PendingTask {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    readonly labels: readonly string[];
    readonly complexity: PlanComplexity | null;
    readonly acceptance: { readonly criteria: readonly string[] };
    readonly requirementsRefs: readonly PlanArtifactRef[];
    readonly dependsOn: readonly string[];
    readonly inputIndex: number;
  }
  const pendingTasks: PendingTask[] = [];

  for (const [index, taskValue] of tasksInput.entries()) {
    const taskField = `tasks[${index}]`;
    const taskObject = requirePlainObject(taskValue, context, taskField);
    rejectUnknownKeys(taskObject, PLAN_TASK_KEYS, context, taskField);

    const id = validateStableId(taskObject.id, context, `${taskField}.id`);
    const taskContext = taskErrorContext(context, id);
    const complexityValue = taskObject.complexity;
    let complexity: PlanComplexity | null = null;
    if (complexityValue !== undefined && complexityValue !== null) {
      if (
        typeof complexityValue !== 'string' ||
        !PLAN_COMPLEXITY_VALUES.includes(complexityValue as PlanComplexity)
      ) {
        throw planError(
          taskContext,
          `${taskField}.complexity`,
          `必须是 ${PLAN_COMPLEXITY_VALUES.join(' / ')} 或 null/省略（复用配置复杂度取值）`,
          undefined,
          complexityValue,
        );
      }
      complexity = complexityValue as PlanComplexity;
    }

    const dependsOnValue = taskObject.dependsOn === undefined ? [] : taskObject.dependsOn;
    if (!Array.isArray(dependsOnValue)) {
      throw planError(taskContext, `${taskField}.dependsOn`, '必须是任务 ID 字符串数组', undefined, taskObject.dependsOn);
    }
    const dependsOn: string[] = [];
    for (const [edgeIndex, edgeValue] of dependsOnValue.entries()) {
      dependsOn.push(requireNonEmptyString(edgeValue, taskContext, `${taskField}.dependsOn[${edgeIndex}]`).trim());
    }

    pendingTasks.push({
      id,
      title: validatePlanTitle(taskObject.title, taskContext, `${taskField}.title`),
      description: validatePlanDescription(taskObject.description, taskContext, `${taskField}.description`),
      labels: normalizeLabels(taskObject.labels, taskContext, `${taskField}.labels`),
      complexity,
      acceptance: validatePlanAcceptance(taskObject.acceptance, taskContext, `${taskField}.acceptance`),
      requirementsRefs: validatePlanArtifactRefs(
        taskObject.requirementsRefs,
        taskContext,
        `${taskField}.requirementsRefs`,
        PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT,
      ),
      dependsOn,
      inputIndex: index,
    });
  }

  // 依赖边总数边界（先于语义检查，保证越界输入的失败确定性）。
  const totalEdgeCount = pendingTasks.reduce((sum, task) => sum + task.dependsOn.length, 0);
  if (totalEdgeCount > PLAN_DEPENDENCY_EDGES_MAX_COUNT) {
    throw planError(
      context,
      'tasks.dependencies',
      `依赖边总数不得超过 ${PLAN_DEPENDENCY_EDGES_MAX_COUNT} 条（输入计 ${totalEdgeCount} 条）`,
    );
  }

  // 成员唯一：重复任务 ID。
  const tasksById = new Map<string, PendingTask>();
  for (const task of pendingTasks) {
    const existing = tasksById.get(task.id);
    if (existing !== undefined) {
      throw planError(
        taskErrorContext(context, task.id),
        `tasks[${task.inputIndex}].id`,
        `重复任务 ID（首次出现于 tasks[${existing.inputIndex}]）`,
        { taskId: task.id },
      );
    }
    tasksById.set(task.id, task);
  }

  // 逐边语义：自依赖、重复依赖、缺依赖、跨 Feature 依赖。
  for (const task of pendingTasks) {
    const taskContext = taskErrorContext(context, task.id);
    const seenTargets = new Set<string>();
    for (const [edgeIndex, target] of task.dependsOn.entries()) {
      const edgeField = `tasks[${task.inputIndex}].dependsOn[${edgeIndex}]`;
      if (target === task.id) {
        throw planError(taskContext, edgeField, '自依赖不被允许', {
          taskId: task.id,
          dependsOnTaskId: target,
        });
      }
      if (seenTargets.has(target)) {
        throw planError(taskContext, edgeField, '重复依赖（同一任务对同一目标的重复边）', {
          taskId: task.id,
          dependsOnTaskId: target,
        });
      }
      seenTargets.add(target);
      if (!tasksById.has(target)) {
        const externalFeatureId = options.externalTasks?.get(target);
        if (externalFeatureId !== undefined) {
          throw planError(
            taskContext,
            edgeField,
            `跨 Feature 依赖不被允许（目标属于 Feature ${externalFeatureId}；task_dependencies 两端必须同 Feature）`,
            { taskId: task.id, dependsOnTaskId: target },
          );
        }
        throw planError(taskContext, edgeField, '缺依赖：目标不在本计划任务集内（同 Feature 任务 ID）', {
          taskId: task.id,
          dependsOnTaskId: target,
        });
      }
    }
  }

  // 环检测：按 id 稳定顺序做三色 DFS，报错携带环路径节点定位。
  const cycle = detectPlanDependencyCycle(pendingTasks.map((task) => ({ id: task.id, dependsOn: [...task.dependsOn] })));
  if (cycle !== undefined) {
    throw planError(context, 'tasks.dependencies', '依赖存在环（环路径见 details.cycle）', {
      cycle,
    });
  }

  const tasks: ValidatedFeaturePlanTask[] = pendingTasks
    .map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      labels: task.labels,
      complexity: task.complexity,
      acceptance: task.acceptance,
      requirementsRefs: task.requirementsRefs,
      dependsOn: [...task.dependsOn].sort(),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const plan: ValidatedFeaturePlan = {
    schemaVersion: FEATURE_PLAN_SCHEMA_VERSION,
    feature,
    tasks,
    taskCount: tasks.length,
    dependencyEdgeCount: totalEdgeCount,
    executable: tasks.length > 0,
    planDigest: '',
  };
  return { ...plan, planDigest: computeFeaturePlanDigest(plan) };
}

/**
 * 三色 DFS 环检测；返回从环起点回到自身的节点路径（如 [a,b,c,a]），无环返回 undefined。
 * P03-1 / F-002 起导出供 plan-store 存储原语在事务内复核同 Feature 依赖无环
 * （DDL 无法表达环约束；应用层校验依据 P03-1 契约 §3）。
 */
export function detectPlanDependencyCycle(
  nodes: readonly { id: string; dependsOn: string[] }[],
): string[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const path: string[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node] as const));

  function visit(nodeId: string): string[] | undefined {
    color.set(nodeId, GRAY);
    path.push(nodeId);
    const node = byId.get(nodeId);
    for (const target of node?.dependsOn ?? []) {
      const targetColor = color.get(target) ?? WHITE;
      if (targetColor === GRAY) {
        const start = path.indexOf(target);
        return [...path.slice(start < 0 ? 0 : start), target];
      }
      if (targetColor === WHITE) {
        const found = visit(target);
        if (found !== undefined) {
          return found;
        }
      }
    }
    path.pop();
    color.set(nodeId, BLACK);
    return undefined;
  }

  for (const node of nodes) {
    if ((color.get(node.id) ?? WHITE) === WHITE) {
      const found = visit(node.id);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 确定性业务摘要（planDigest）
 * ------------------------------------------------------------------ */

/**
 * 递归键排序的稳定 JSON 序列化（数组保持元素顺序；对象键按字典序输出，
 * undefined 值省略）。P03-2 / F-003 起导出：检查政策身份摘要与 planDigest
 * 共用同一稳定序列化规则，不另立第二套规范化。
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalRef(ref: PlanArtifactRef): Record<string, string> {
  return ref.contentHash === undefined
    ? { artifactId: ref.artifactId }
    : { artifactId: ref.artifactId, contentHash: ref.contentHash };
}

/**
 * 规范化业务 JSON（planDigest 的输入）：只含业务执行依据 —— Feature 标题/业务描述/
 * 来源引用、每个 Task 的 id/标题/业务描述/complexity/结构化验收/需求引用/依赖边。
 * 任务按 id 排序、依赖与引用按身份排序、对象键递归排序；**不包含** labels、
 * revision、时间戳、策略来源说明等非业务字段（它们不在计划 payload 白名单内，
 * 或按契约明确排除在业务摘要之外）。
 */
export function canonicalFeaturePlanBusinessJson(plan: ValidatedFeaturePlan): string {
  const business = {
    feature: {
      title: plan.feature.title,
      description: plan.feature.description,
      sourceRefs: [...plan.feature.sourceRefs]
        .sort((left, right) => {
          if (left.artifactId !== right.artifactId) {
            return left.artifactId < right.artifactId ? -1 : 1;
          }
          const leftHash = left.contentHash ?? '';
          const rightHash = right.contentHash ?? '';
          return leftHash === rightHash ? 0 : leftHash < rightHash ? -1 : 1;
        })
        .map(canonicalRef),
    },
    tasks: [...plan.tasks]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        complexity: task.complexity,
        acceptance: { criteria: [...task.acceptance.criteria] },
        requirementsRefs: [...task.requirementsRefs]
          .sort((left, right) => {
            if (left.artifactId !== right.artifactId) {
              return left.artifactId < right.artifactId ? -1 : 1;
            }
            const leftHash = left.contentHash ?? '';
            const rightHash = right.contentHash ?? '';
            return leftHash === rightHash ? 0 : leftHash < rightHash ? -1 : 1;
          })
          .map(canonicalRef),
        dependsOn: [...task.dependsOn].sort(),
      })),
  };
  return stableStringify(business);
}

/**
 * 确定性业务计划摘要：SHA-256(`${PLAN_DIGEST_DOMAIN}\n${canonicalFeaturePlanBusinessJson(plan)}`)，
 * 64 位小写十六进制。顺序（JSON 键/任务/依赖边/引用）无关；需求、验收、业务描述、
 * 依赖或其他已约定执行依据变化即改变；纯标签、revision、时间戳及策略来源说明变化
 * 不改变（后三者无法进入计划 payload，标签被明确排除）。planDigest 是业务内容摘要，
 * 供审批绑定与变更识别（F-007/F-008），不是 CAS 依据。
 */
export function computeFeaturePlanDigest(plan: ValidatedFeaturePlan): string {
  const canonical = canonicalFeaturePlanBusinessJson(plan);
  return createHash('sha256').update(`${PLAN_DIGEST_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}
