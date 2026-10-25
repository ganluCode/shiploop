/**
 * F-010 授权查询响应形状与窄读取端口（ports 纯契约层）。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md §7（查询与分页）与 §8
 * （快照与水位）：
 * - §7.2 查询响应字段集冻结：projects.list → {schemaVersion:2, scope:
 *   'project-list', records, nextCursor, limit}；projects.get → {project,
 *   binding}（无绑定 binding:null）；projects.labelCounts → {labels}；
 *   settings.*.get → {scope, schemaVersion, revision, payload}；
 * - §8 快照内容（项目 + 绑定 + 项目当前配置 + 有效配置 + 水位 / 全局当前
 *   配置 + 水位）与 watermark 必须取自**同一 SQLite 一致读视图**——本模块的
 *   ConsistentSnapshotStore 窄端口一次性返回该视图的全部行与
 *   MAX(state_events.sequence)，禁止「多次独立读取后随手拼水位」；
 * - 授权可见范围（PrincipalScope，来自 authorization.ts）作为谓词下推到
 *   SQL：先收窄再分页/计数，禁止全库分页后内存过滤；
 * - 公开记录形状：项目/绑定的 UTC 毫秒时间在边界转为 ISO UTC 字符串
 *   （createdAt/updatedAt），内部 *UtcMs 字段不进入公开面；F-007/F-008 命令
 *   结果与 F-010 查询响应共用同一组转换函数，不另立第二套序列化规则。
 *
 * 纯度不变量：只做类型声明、纯转换与可信装配形状断言（编程错误抛
 * TypeError）；不读时钟/文件系统/网络/数据库，不导入 HTTP/SSE/ORM/Pi SDK，
 * 不接触适配器。真实 SQLite 读取实现在 adapters 层。
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { PrincipalScope } from './authorization.js';
import { PublicError, WIRE_MESSAGE_SCHEMA_VERSION, isUuidV4 } from './commands.js';
import type {
  BaselineAuthorizationRecord,
  BaselineCheckResultRecord,
  BaselineOperationPage,
  BaselineOperationRecord,
} from './baseline-store.js';
import type { SettingsPayload, SettingsScope } from './settings-schema.js';
import type { PlanArtifactRef, PlanComplexity } from './feature-plan.js';
import type { FeatureDagReadiness, FeatureDependencyRecord } from './feature-dag.js';
import type {
  FeaturePlanStatus,
  FeatureRecord,
  PhaseRecord,
  PhaseStatus,
  PlanApprovalRecord,
  TaskDependencyRecord,
  TaskRecord,
  TaskStatus,
} from './plan-store.js';
import type { PlanApprovalValidity } from './plan-approval-verification.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requirePlainObject,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';
import type {
  GlobalSettingsRecord,
  ProjectLabelCount,
  ProjectPage,
  ProjectRecord,
  ProjectSettingsRecord,
  ProjectStatus,
  RepositoryBindingRecord,
} from './state-store.js';

/* ------------------------------------------------------------------ *
 * §7.2 公开记录形状与共享转换（命令结果与查询响应共用）
 * ------------------------------------------------------------------ */

/** 公开项目记录：与 ProjectRecord 字段一一对应，时间字段为 ISO UTC。 */
export interface PublicProjectRecord {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly labels: readonly string[];
  readonly repositoryBindingId: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicProjectRecord(project: ProjectRecord): PublicProjectRecord {
  return {
    id: project.id,
    displayName: project.displayName,
    description: project.description,
    status: project.status,
    labels: [...project.labels],
    repositoryBindingId: project.repositoryBindingId,
    revision: project.revision,
    createdAt: new Date(project.createdAtUtcMs).toISOString(),
    updatedAt: new Date(project.updatedAtUtcMs).toISOString(),
  };
}

/** 公开仓库绑定记录：时间字段为 ISO UTC；canonicalPath 为已授权注册事实。 */
export interface PublicRepositoryBindingRecord {
  readonly id: string;
  readonly projectId: string;
  readonly canonicalPath: string;
  readonly gitCommonDir: string | null;
  readonly repoIdentity: string;
  readonly revision: number;
  readonly bindingRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicRepositoryBindingRecord(
  binding: RepositoryBindingRecord,
): PublicRepositoryBindingRecord {
  return {
    id: binding.id,
    projectId: binding.projectId,
    canonicalPath: binding.canonicalPath,
    gitCommonDir: binding.gitCommonDir,
    repoIdentity: binding.repoIdentity,
    revision: binding.revision,
    bindingRevision: binding.bindingRevision,
    createdAt: new Date(binding.createdAtUtcMs).toISOString(),
    updatedAt: new Date(binding.updatedAtUtcMs).toISOString(),
  };
}

/**
 * 公开 Phase 记录（P03-1 / F-004）：与 PhaseRecord 字段一一对应，时间字段为
 * ISO UTC；命令结果与后续查询响应共用同一转换。
 */
export interface PublicPhaseRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: readonly string[];
  readonly status: PhaseStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicPhaseRecord(phase: PhaseRecord): PublicPhaseRecord {
  return {
    id: phase.id,
    projectId: phase.projectId,
    title: phase.title,
    description: phase.description,
    labels: [...phase.labels],
    status: phase.status,
    revision: phase.revision,
    createdAt: new Date(phase.createdAtUtcMs).toISOString(),
    updatedAt: new Date(phase.updatedAtUtcMs).toISOString(),
  };
}

/**
 * 公开 Feature 记录（P03-1 / F-005）：与 FeatureRecord 字段一一对应，时间字段
 * 为 ISO UTC；导入命令结果与后续查询响应共用同一转换。不携带策略副本正文
 * （策略细节经 Task 查询面读取，避免命令结果膨胀）。
 */
export interface PublicFeatureRecord {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: readonly string[];
  readonly status: FeatureRecord['status'];
  readonly planStatus: FeatureRecord['planStatus'];
  readonly planDigest: string | null;
  readonly sourceRefs: readonly { readonly artifactId: string; readonly contentHash?: string }[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicFeatureRecord(feature: FeatureRecord): PublicFeatureRecord {
  return {
    id: feature.id,
    projectId: feature.projectId,
    phaseId: feature.phaseId,
    title: feature.title,
    description: feature.description,
    labels: [...feature.labels],
    status: feature.status,
    planStatus: feature.planStatus,
    planDigest: feature.planDigest,
    sourceRefs: feature.sourceRefs.map(ref =>
      ref.contentHash === undefined ? { artifactId: ref.artifactId } : { ...ref },
    ),
    revision: feature.revision,
    createdAt: new Date(feature.createdAtUtcMs).toISOString(),
    updatedAt: new Date(feature.updatedAtUtcMs).toISOString(),
  };
}

/**
 * §7.2 settings.*.get 的当前值形状（也是 F-009 配置命令的固化结果形状）：
 * 只含 scope/schemaVersion/revision/payload，不含存储内部 id/时间戳。
 */
export interface PublicSettingsState {
  readonly scope: SettingsScope;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly payload: SettingsPayload;
}

export function toPublicSettingsState(
  scope: SettingsScope,
  record: GlobalSettingsRecord | ProjectSettingsRecord,
): PublicSettingsState {
  return {
    scope,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    payload: record.payload,
  };
}

/* ------------------------------------------------------------------ *
 * §7.2 查询响应形状（字段集冻结）
 * ------------------------------------------------------------------ */

/** projects.list → {schemaVersion:2, scope:'project-list', records, nextCursor, limit}。 */
export interface ProjectListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'project-list';
  readonly records: readonly PublicProjectRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

/** projects.get → {project, binding}；项目尚无绑定时 binding 为 null。 */
export interface ProjectDetailResult {
  readonly project: PublicProjectRecord;
  readonly binding: PublicRepositoryBindingRecord | null;
}

/** projects.binding.get → {binding}。 */
export interface ProjectBindingResult {
  readonly binding: PublicRepositoryBindingRecord;
}

/** projects.labelCounts → {labels}（仅可见项目去重计数）。 */
export interface ProjectLabelCountsResult {
  readonly labels: readonly ProjectLabelCount[];
}

/* ------------------------------------------------------------------ *
 * 窄读取端口：可见谓词下推的项目列表/计数
 * ------------------------------------------------------------------ */

/**
 * 可信装配形状断言：PrincipalScope 必须来自经 assertTrustedPrincipal 核验的
 * principal（application 层已把关）；此处复核是防御纵深——形状非法属于可信
 * 装配编程错误，抛 TypeError，绝不折算为面向客户端错误，绝不静默放宽为 all。
 */
export function assertPrincipalVisibility(value: unknown): asserts value is PrincipalScope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PrincipalScope 必须是对象（可信装配编程错误）');
  }
  const candidate = value as { readonly kind?: unknown; readonly projectIds?: unknown };
  if (candidate.kind === 'all') {
    if (Object.keys(value).length !== 1) {
      throw new TypeError("PrincipalScope kind='all' 不允许携带其他键");
    }
    return;
  }
  if (candidate.kind !== 'allowlist') {
    throw new TypeError("PrincipalScope.kind 必须是 'all' 或 'allowlist'");
  }
  if (Object.keys(value).length !== 2 || !Array.isArray(candidate.projectIds)) {
    throw new TypeError('PrincipalScope allowlist 必须且只携带 projectIds 数组');
  }
  if (candidate.projectIds.length === 0) {
    throw new TypeError('PrincipalScope allowlist 不允许为空（可见范围必须显式）');
  }
  const seen = new Set<string>();
  for (const projectId of candidate.projectIds) {
    if (!isUuidV4(projectId)) {
      throw new TypeError('PrincipalScope allowlist 项目必须是 UUID v4');
    }
    if (seen.has(projectId)) {
      throw new TypeError('PrincipalScope allowlist 不允许重复项目');
    }
    seen.add(projectId);
  }
}

/**
 * 授权项目列表/标签计数窄读取端口（§4.3/§7.1）：可见范围谓词随查询下推
 * （SQL WHERE），先收窄再分页/计数。filter 输入为 unknown，实现方在任何 SQL
 * 之前复用 P01 validateProjectListFilter 校验（非法 limit/cursor/未知键
 * 拒绝）；visibility 非法形状为编程错误（TypeError）。
 */
export interface AuthorizedProjectReadStore {
  listVisibleProjects(visibility: unknown, filter: unknown): ProjectPage;
  countVisibleProjectLabels(visibility: unknown): readonly ProjectLabelCount[];
}

/* ------------------------------------------------------------------ *
 * §8 一致读视图窄端口
 * ------------------------------------------------------------------ */

/**
 * 快照一致读视图：同一 SQLite 读事务内取得的全部内容行与
 * MAX(state_events.sequence)（空库 0）。project scope 视图 project 缺失即
 * StorageError(not_found)（由应用层折算 forbidden）；settings 未配置为 null
 * （与损坏严格区分，不降级成已配置）。
 */
export interface SnapshotView {
  /** project scope：项目当前状态；global scope：null。 */
  readonly project: ProjectRecord | null;
  /** project scope：仓库绑定（无绑定 null）；global scope：null。 */
  readonly binding: RepositoryBindingRecord | null;
  /** project scope：项目当前配置（未配置 null）；global scope：null。 */
  readonly projectSettings: ProjectSettingsRecord | null;
  /** 全局当前配置（未配置 null）；项目有效配置合并的全局来源依赖。 */
  readonly globalSettings: GlobalSettingsRecord | null;
  /** 同一读视图内的 MAX(state_events.sequence)（全局持久序列，空库 0）。 */
  readonly maxEventSequence: number;
}

/**
 * §8 一致读视图端口：实现方必须以单个 SQLite 读事务（DEFERRED）取得视图——
 * 视图内任何后续写入要么整体可见（其事件 sequence 已计入水位），要么整体
 * 不可见（sequence 严格大于水位），不存在中间形态。在读事务之外或嵌套于
 * 写事务内调用是编程错误（TypeError）。
 */
export interface ConsistentSnapshotStore {
  readProjectSnapshotView(projectId: unknown): SnapshotView;
  readGlobalSnapshotView(): SnapshotView;
}

/* ------------------------------------------------------------------ *
 * P02-3 §7.2 绑定查找窄端口（docs/p02-3-onboarding-contract.md）
 * ------------------------------------------------------------------ */

/**
 * 按 canonicalPath 只读查找仓库绑定的窄端口：projects.inspect 的
 * alreadyRegistered 判定只经本端口接入（不写任何行、不在写事务内调用）。
 * canonicalPath 输入为 unknown，实现方在任何 SQL 之前校验为非空绝对路径
 * 字符串（非法输入为 StorageError kind='validation'，由应用层映射为
 * invalid_input）；未命中返回 null（与「不存在」显式区分，不抛错）。
 */
export interface RepositoryBindingLookupStore {
  findBindingByCanonicalPath(canonicalPath: unknown): RepositoryBindingRecord | null;
}

/* ------------------------------------------------------------------ *
 * P02-3 / F-014 §7.4–§7.6 基线查询与证据读取窄端口
 * ------------------------------------------------------------------ */

/**
 * 基线查询只读窄端口（§7.4/§7.5）：分页/单次操作/逐项检查/不可变授权的
 * 读取面；授权与可见性判定在应用层完成后才调用。operationId 输入为 unknown，
 * 实现方在 SQL 之前完成同一身份校验（非法稳定身份为 validation 错误）。
 */
export interface BaselineQueryReadStore {
  listBaselineOperations(projectId: unknown, query: unknown): BaselineOperationPage;
  getBaselineOperation(operationId: unknown): BaselineOperationRecord | undefined;
  listBaselineCheckResults(operationId: unknown): readonly BaselineCheckResultRecord[];
  getBaselineAuthorization(authorizationId: unknown): BaselineAuthorizationRecord | undefined;
  /**
   * §7.6 artifacts.get 的成员解析：按制品身份反查其所属项目与操作
   * （仅 baseline_check_results.output_artifact_id 命中；未命中返回 undefined）。
   */
  findBaselineOutputArtifact(artifactId: unknown):
    | { readonly projectId: string; readonly operationId: string }
    | undefined;
}

/* ------------------------------------------------------------------ *
 * P03-1 / F-006 计划查询：公开形状、分页游标与窄读取端口
 * （docs/p03-1-plan-import-contract.md §6.6 查询面定案）
 * ------------------------------------------------------------------ */

/**
 * 计划查询操作身份（PublicError.operation 与后续 Host 路由共用；线接入由
 * F-009/F-010 冻结，本清单不提前进入握手能力集合）。
 */
export const PHASE_GRAPH_QUERY_OPERATION = 'phases.graph.get' as const;

export const PLAN_QUERY_OPERATIONS = [
  'phases.list',
  'phases.get',
  'features.list',
  'features.get',
  'tasks.list',
  'tasks.get',
] as const;

export type PlanQueryOperation = (typeof PLAN_QUERY_OPERATIONS)[number];

/* ---------------------------- 公开记录形状 ---------------------------- */

/**
 * 公开 Task 记录（P03-1 / F-006）：与 TaskRecord 字段一一对应（含结构化验收、
 * 需求/验收引用、完整策略副本与来源说明），时间为 ISO UTC；查询响应与未来命令
 * 结果共用同一转换。策略副本是导入事务固化的完整独立副本（不是动态引用）。
 */
export interface PublicTaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: readonly string[];
  readonly status: TaskStatus;
  readonly complexity: PlanComplexity | null;
  readonly acceptance: { readonly criteria: readonly string[] };
  readonly requirementsRefs: readonly PlanArtifactRef[];
  readonly executionConfig: Readonly<Record<string, unknown>>;
  readonly configSource: string;
  readonly configSourceKey: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicTaskRecord(task: TaskRecord): PublicTaskRecord {
  return {
    id: task.id,
    projectId: task.projectId,
    featureId: task.featureId,
    title: task.title,
    description: task.description,
    labels: [...task.labels],
    status: task.status,
    complexity: task.complexity,
    acceptance: { criteria: [...task.acceptance.criteria] },
    requirementsRefs: task.requirementsRefs.map(ref =>
      ref.contentHash === undefined ? { artifactId: ref.artifactId } : { ...ref },
    ),
    executionConfig: task.executionConfig,
    configSource: task.configSource,
    configSourceKey: task.configSourceKey,
    revision: task.revision,
    createdAt: new Date(task.createdAtUtcMs).toISOString(),
    updatedAt: new Date(task.updatedAtUtcMs).toISOString(),
  };
}

/** 同 Feature Task 依赖边公开形状（只暴露业务两端，不暴露内部行身份/时间）。 */
export interface PublicTaskDependencyEdge {
  readonly taskId: string;
  readonly dependsOnId: string;
}

export function toPublicTaskDependencyEdge(
  dependency: TaskDependencyRecord,
): PublicTaskDependencyEdge {
  return { taskId: dependency.taskId, dependsOnId: dependency.dependsOnId };
}

/* ---------------------------- 可执行性视图 ---------------------------- */

/**
 * Feature 不可执行原因（有界枚举，稳定顺序）：
 * - no_tasks：空草稿（F-001 §3.1 明确不可执行）；
 * - plan_not_approved：planStatus ≠ approved，未获批准的计划不得启动执行。
 * 只反映持久状态的推导结果，绝不虚构 Run/Attempt 结果。
 */
export const FEATURE_NOT_EXECUTABLE_REASONS = ['no_tasks', 'plan_not_approved'] as const;
export type FeatureNotExecutableReason = (typeof FEATURE_NOT_EXECUTABLE_REASONS)[number];

/** F-001 §3.1 同源结构校验摘要（与 feature.plan.import 回执 validation 同语义）。 */
export interface FeaturePlanValidationSummary {
  readonly taskCount: number;
  readonly dependencyEdgeCount: number;
  /** 结构前提（taskCount > 0）：不代表已批准、配置就绪或可启动 Run。 */
  readonly executable: boolean;
}

/** 由持久状态推导不可执行原因（纯函数；稳定顺序见 FEATURE_NOT_EXECUTABLE_REASONS）。 */
export function deriveFeatureNotExecutableReasons(input: {
  readonly taskCount: number;
  readonly planStatus: FeaturePlanStatus;
}): readonly FeatureNotExecutableReason[] {
  const reasons: FeatureNotExecutableReason[] = [];
  if (input.taskCount === 0) reasons.push('no_tasks');
  if (input.planStatus !== 'approved') reasons.push('plan_not_approved');
  return reasons;
}

export const FEATURE_GRAPH_BLOCKER_REASONS = [
  'missing_dependency',
  'no_tasks',
  'plan_not_approved',
  'dependency_pending',
  'dependency_failed',
  'active_batch_scope',
  'code_baseline_missing',
  'integration_not_ready',
  'invalid_graph',
] as const;
export type FeatureGraphBlockerReason = (typeof FEATURE_GRAPH_BLOCKER_REASONS)[number];

/** Phase 图查询的稳定阻塞投影，输入必须来自同一一致读视图。 */
export function derivePhaseFeatureBlockers(input: {
  readonly readiness: FeatureDagReadiness;
  readonly taskCount: number;
  readonly planStatus: FeaturePlanStatus;
  readonly activeBatch: boolean;
  readonly missingCodeBaseline: boolean;
  readonly missingDependencyIds: readonly string[];
}): readonly FeatureGraphBlockerReason[] {
  const blockers: FeatureGraphBlockerReason[] = [];
  if (input.missingDependencyIds.length > 0) blockers.push('missing_dependency');
  if (input.taskCount === 0) blockers.push('no_tasks');
  if (input.planStatus !== 'approved') blockers.push('plan_not_approved');
  if (input.readiness.reason === 'dependency_pending') blockers.push('dependency_pending');
  if (input.readiness.reason === 'dependency_failed') blockers.push('dependency_failed');
  if (input.activeBatch) blockers.push('active_batch_scope');
  if (input.missingCodeBaseline) blockers.push('code_baseline_missing');
  if (input.readiness.reason === 'integration_not_ready') blockers.push('integration_not_ready');
  if (input.readiness.reason === 'invalid_graph') blockers.push('invalid_graph');
  return blockers;
}

/* ---------------------------- 查询结果形状 ---------------------------- */

/** Phase 图依赖边公开形状；固定基线引用不代表集成已完成。 */
export interface PublicFeatureDependencyEdge {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly dependsOnId: string;
  readonly codeBaselineRef: string | null;
}

export function toPublicFeatureDependencyEdge(
  dependency: FeatureDependencyRecord,
): PublicFeatureDependencyEdge {
  if (dependency.id === null) {
    throw new TypeError('Feature 依赖边缺少持久身份（适配器实现缺陷）');
  }
  return {
    id: dependency.id,
    projectId: dependency.projectId,
    phaseId: dependency.phaseId,
    featureId: dependency.featureId,
    dependsOnId: dependency.dependsOnId,
    codeBaselineRef: dependency.codeBaselineRef,
  };
}

export interface PhaseGraphFeatureReadiness extends FeatureDagReadiness {
  readonly blockers: readonly FeatureGraphBlockerReason[];
}

export interface PhaseGraphResult extends PlanListResultBase {
  readonly scope: 'phase-graph';
  readonly phase: PublicPhaseRecord;
  readonly features: readonly PublicFeatureRecord[];
  readonly dependencies: readonly PublicFeatureDependencyEdge[];
  readonly readiness: readonly PhaseGraphFeatureReadiness[];
  readonly readyFeatureIds: readonly string[];
  readonly executableFeatureIds: readonly string[];
}

/** phases.graph.get 的一致读视图。 */
export interface PhaseFeatureGraphView {
  readonly phase: PhaseRecord;
  readonly features: readonly FeatureRecord[];
  readonly dependencies: readonly FeatureDependencyRecord[];
  readonly taskCounts: Readonly<Record<string, number>>;
  readonly activeFeatureIds: readonly string[];
}

/** phases.get → {phase}（真实父级 projectId 在记录内）。 */
export interface PhaseDetailResult {
  readonly phase: PublicPhaseRecord;
}

/** tasks.get → {task}（真实父级 featureId/projectId、验收/引用/策略副本/来源在记录内）。 */
export interface TaskDetailResult {
  readonly task: PublicTaskRecord;
}

/**
 * features.get → {feature, validation, notExecutableReasons, tasks, dependencies}：
 * Feature 与完整同 Feature Task DAG（节点 + 依赖边）来自同一一致读视图；
 * validation 与 F-001/导入回执同源；结果有界（≤ PLAN_TASKS_MAX_COUNT 节点）
 * 且不含任何 Run/Attempt 结果。
 */
export interface FeatureDetailResult {
  readonly feature: PublicFeatureRecord;
  readonly validation: FeaturePlanValidationSummary;
  readonly notExecutableReasons: readonly FeatureNotExecutableReason[];
  readonly tasks: readonly PublicTaskRecord[];
  readonly dependencies: readonly PublicTaskDependencyEdge[];
}

/** 层级列表响应公共字段（与 ProjectListResult 同纪律：字段集冻结）。 */
export interface PlanListResultBase {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly nextCursor: string | null;
  readonly limit: number;
}

/** phases.list → {schemaVersion, scope:'phase-list', records, nextCursor, limit}。 */
export interface PhaseListResult extends PlanListResultBase {
  readonly scope: 'phase-list';
  readonly records: readonly PublicPhaseRecord[];
}

/** features.list → {schemaVersion, scope:'feature-list', records, nextCursor, limit}。 */
export interface FeatureListResult extends PlanListResultBase {
  readonly scope: 'feature-list';
  readonly records: readonly PublicFeatureRecord[];
}

/** tasks.list → {schemaVersion, scope:'task-list', records, nextCursor, limit}。 */
export interface TaskListResult extends PlanListResultBase {
  readonly scope: 'task-list';
  readonly records: readonly PublicTaskRecord[];
}

/* ---------------------------- 分页过滤器 ---------------------------- */

/** 计划层级列表分页：默认 50 / 上限 200（与项目列表同一量级；边界值通过、越界拒绝）。 */
export const PLAN_LIST_DEFAULT_LIMIT = 50;
export const PLAN_LIST_MAX_LIMIT = 200;

export interface ValidatedPlanListFilter {
  readonly limit: number;
  /** 不透明游标原文（形态由 decodePlanListCursor 核验）。 */
  readonly cursor?: string;
}

/**
 * 计划层级列表过滤器校验（unknown → 已校验形态）：只允许 limit/cursor；非法
 * limit（非 1..PLAN_LIST_MAX_LIMIT 整数）/非法 cursor 形态/未知键（含提权字段
 * actorId/principal/capabilities/scope）在任何 SQL 之前拒绝。
 */
export function validatePlanListFilter(value: unknown, operation: string): ValidatedPlanListFilter {
  const context: ValidationContext = { operation, entity: { type: 'project' } };
  if (value === undefined || value === null) {
    return { limit: PLAN_LIST_DEFAULT_LIMIT };
  }
  const object = requirePlainObject(value, context, 'filter');
  rejectUnknownKeys(object, ['limit', 'cursor'], context, 'filter');
  let limit = PLAN_LIST_DEFAULT_LIMIT;
  if (object.limit !== undefined) {
    if (
      typeof object.limit !== 'number' ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > PLAN_LIST_MAX_LIMIT
    ) {
      throw validationError(
        context,
        'filter.limit',
        `必须是 1..${PLAN_LIST_MAX_LIMIT} 的整数（每页上限）`,
        object.limit,
      );
    }
    limit = object.limit;
  }
  if (object.cursor !== undefined) {
    if (typeof object.cursor !== 'string' || object.cursor.length === 0) {
      throw validationError(context, 'filter.cursor', '必须是非空字符串（不透明游标）', object.cursor);
    }
    return { limit, cursor: object.cursor };
  }
  return { limit };
}

/* ---------------------------- 受控分页游标 ---------------------------- */

/** 游标线消息前缀与载荷版本（与事件游标同一纪律）。 */
export const PLAN_LIST_CURSOR_PREFIX = 'plcur_v1_';
export const PLAN_LIST_CURSOR_VERSION = 1 as const;

/** 列表父级 scope：游标绑定数据根 + 列表层级 + 项目 + 父级（跨项目/跨父级拒绝）。
 *  P03-3 / F-010 起含 'budget-revisions'（预算修订历史分页，父级为 Batch）；
 *  P03-4 / F-007 起含 'task-attempts'（Attempt 审计分页，父级为 Task）与
 *  'attempt-diagnostics'（迟到/越权通知诊断分页，父级为 Attempt）；
 *  P03-6 / F-011 起含 'run-work-sessions' 与 'task-work-sessions'（Work
 *  Session 列表分页，父级为 Run / Task）；P03-7 / F-013 起含
 *  'task-approvals'（Task 人审事项分页，父级为 Task）与 'task-rework-chain'
 *  （有限返工链分页，父级为 Task）。P03-8 / F-009 起含
 *  'feature-git-operations' 与 'run-git-operations'（Git 操作列表分页，
 *  父级为 Feature / Run）。P05-1 / F-011 起含 'planning-contexts'（项目范围
 *  规划上下文分页）与 'feature-planning-contexts'（Feature 过滤的规划
 *  上下文分页；游标绑定数据根 + 项目 + Feature，跨项目/跨过滤重放拒绝）。 */
export type PlanListScope =
  | { readonly kind: 'work-recording'; readonly projectId: string; readonly parentKind: 'run' | 'attempt' | 'session'; readonly parentId: string; readonly recordType: 'messages' | 'manifests' }
  | { readonly kind: 'phases'; readonly projectId: string }
  | { readonly kind: 'phase-graph'; readonly projectId: string; readonly phaseId: string }
  | { readonly kind: 'features'; readonly projectId: string; readonly phaseId: string }
  | { readonly kind: 'tasks'; readonly projectId: string; readonly featureId: string }
  | { readonly kind: 'budget-revisions'; readonly projectId: string; readonly batchId: string }
  | { readonly kind: 'task-attempts'; readonly projectId: string; readonly taskId: string }
  | { readonly kind: 'attempt-diagnostics'; readonly projectId: string; readonly attemptId: string }
  | { readonly kind: 'run-work-sessions'; readonly projectId: string; readonly runId: string }
  | { readonly kind: 'task-work-sessions'; readonly projectId: string; readonly taskId: string }
  | { readonly kind: 'task-approvals'; readonly projectId: string; readonly taskId: string }
  | { readonly kind: 'task-rework-chain'; readonly projectId: string; readonly taskId: string }
  | { readonly kind: 'feature-git-operations'; readonly projectId: string; readonly featureId: string }
  | { readonly kind: 'run-git-operations'; readonly projectId: string; readonly runId: string }
  /** P05-4：只读派发范围；最多选择一个固定 Batch 或 Feature。 */
  | { readonly kind: 'dispatch-queue-batch'; readonly projectId: string; readonly batchId: string }
  | { readonly kind: 'dispatch-queue-feature'; readonly projectId: string; readonly featureId: string }
  /** P04-9 / F-008 派发队列与槽位只读投影：项目范围分页（父级固定为项目）。 */
  | { readonly kind: 'dispatch-queue'; readonly projectId: string }
  /** P05-1 / F-011 项目范围规划上下文分页（无 Feature 过滤）。 */
  | { readonly kind: 'planning-contexts'; readonly projectId: string }
  /** P05-1 / F-011 Feature 过滤的规划上下文分页（游标绑定同一过滤）。 */
  | { readonly kind: 'feature-planning-contexts'; readonly projectId: string; readonly featureId: string }
  /** P05-8：项目范围 GitAgent 修复查询。 */
  | { readonly kind: 'git-repairs'; readonly projectId: string }
  /** P05-5：项目/Feature/Batch 资源租约分页；游标绑定筛选范围。 */
  | { readonly kind: 'execution-resources'; readonly projectId: string; readonly featureId?: string; readonly batchId?: string };
/** 游标签发/解析绑定：数据根身份 + 列表 scope（只允许可信装配构造）。 */
export interface PlanListCursorBinding {
  readonly rootIdentity: string;
  readonly scope: PlanListScope;
}

const PLAN_ROOT_IDENTITY_PATTERN = /^[0-9a-f]{64}$/;
const PLAN_ROOT_FINGERPRINT_LENGTH = 16;
const PLAN_CURSOR_STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function planInvalidInput(operation: string, field: string, reason: string, received?: unknown): never {
  throw new PublicError('invalid_input', operation, undefined, {
    details: {
      field,
      reason,
      ...(received !== undefined
        ? { receivedType: received === null ? 'null' : Array.isArray(received) ? 'array' : typeof received }
        : {}),
    },
  });
}

function planScopeShapeError(reason: string): never {
  throw new TypeError(`PlanListCursorBinding 形态非法（可信装配编程错误）：${reason}`);
}

/** 可信装配形状断言：绑定必须由本模块构造；形态非法是编程错误（TypeError）。 */
export function createPlanListCursorBinding(
  input: unknown,
  operation: string = 'PlanListCursor.createBinding',
): PlanListCursorBinding {
  if (!isPlainObject(input)) {
    planInvalidInput(operation, 'binding', '必须是对象', input);
  }
  rejectUnknownKeys(input, ['rootIdentity', 'scope'], { operation }, 'binding');
  if (typeof input.rootIdentity !== 'string' || !PLAN_ROOT_IDENTITY_PATTERN.test(input.rootIdentity)) {
    planInvalidInput(operation, 'rootIdentity', '必须是 64 位小写十六进制数据根身份', input.rootIdentity);
  }
  const scope = input.scope;
  if (!isPlainObject(scope)) {
    planInvalidInput(operation, 'scope', '必须是对象', scope);
  }
  if (scope.kind === 'work-recording') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'parentKind', 'parentId', 'recordType'], { operation }, 'scope');
    if (!['run', 'attempt', 'session'].includes(String(scope.parentKind))
      || !['messages', 'manifests'].includes(String(scope.recordType))) {
      planInvalidInput(operation, 'scope', 'Invalid recording scope');
    }
    return { rootIdentity: input.rootIdentity, scope: { kind: 'work-recording',
      projectId: validateStableId(scope.projectId, { operation }, 'scope.projectId'),
      parentId: validateStableId(scope.parentId, { operation }, 'scope.parentId'),
      parentKind: scope.parentKind as 'run' | 'attempt' | 'session', recordType: scope.recordType as 'messages' | 'manifests' } };
  }
  if (scope.kind === 'phases') {
    rejectUnknownKeys(scope, ['kind', 'projectId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'phases',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
      },
    };
  }
  if (scope.kind === 'phase-graph') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'phaseId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'phase-graph',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        phaseId: validateStableId(scope.phaseId, { operation, entity: { type: 'phase' } }, 'scope.phaseId'),
      },
    };
  }
  if (scope.kind === 'features') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'phaseId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'features',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        phaseId: validateStableId(scope.phaseId, { operation, entity: { type: 'phase' } }, 'scope.phaseId'),
      },
    };
  }
  if (scope.kind === 'tasks') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'featureId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'tasks',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        featureId: validateStableId(scope.featureId, { operation, entity: { type: 'feature' } }, 'scope.featureId'),
      },
    };
  }
  if (scope.kind === 'budget-revisions') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'batchId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'budget-revisions',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        batchId: validateStableId(scope.batchId, { operation, entity: { type: 'execution_batch' } }, 'scope.batchId'),
      },
    };
  }
  if (scope.kind === 'task-attempts') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'taskId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'task-attempts',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        taskId: validateStableId(scope.taskId, { operation, entity: { type: 'task' } }, 'scope.taskId'),
      },
    };
  }
  if (scope.kind === 'attempt-diagnostics') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'attemptId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'attempt-diagnostics',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        attemptId: validateStableId(scope.attemptId, { operation, entity: { type: 'attempt' } }, 'scope.attemptId'),
      },
    };
  }
  if (scope.kind === 'run-work-sessions') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'runId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'run-work-sessions',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        runId: validateStableId(scope.runId, { operation, entity: { type: 'run' } }, 'scope.runId'),
      },
    };
  }
  if (scope.kind === 'task-work-sessions') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'taskId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'task-work-sessions',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        taskId: validateStableId(scope.taskId, { operation, entity: { type: 'task' } }, 'scope.taskId'),
      },
    };
  }
  if (scope.kind === 'task-approvals') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'taskId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'task-approvals',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        taskId: validateStableId(scope.taskId, { operation, entity: { type: 'task' } }, 'scope.taskId'),
      },
    };
  }
  if (scope.kind === 'task-rework-chain') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'taskId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'task-rework-chain',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        taskId: validateStableId(scope.taskId, { operation, entity: { type: 'task' } }, 'scope.taskId'),
      },
    };
  }
  if (scope.kind === 'feature-git-operations') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'featureId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'feature-git-operations',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        featureId: validateStableId(scope.featureId, { operation, entity: { type: 'feature' } }, 'scope.featureId'),
      },
    };
  }
  if (scope.kind === 'run-git-operations') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'runId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'run-git-operations',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        runId: validateStableId(scope.runId, { operation, entity: { type: 'run' } }, 'scope.runId'),
      },
    };
  }
  if (scope.kind === 'dispatch-queue-batch') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'batchId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'dispatch-queue-batch',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        batchId: validateStableId(scope.batchId, { operation, entity: { type: 'execution_batch' } }, 'scope.batchId'),
      },
    };
  }
  if (scope.kind === 'dispatch-queue-feature') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'featureId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'dispatch-queue-feature',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        featureId: validateStableId(scope.featureId, { operation, entity: { type: 'feature' } }, 'scope.featureId'),
      },
    };
  }
  if (scope.kind === 'dispatch-queue') {
    rejectUnknownKeys(scope, ['kind', 'projectId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'dispatch-queue',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
      },
    };
  }
  if (scope.kind === 'git-repairs') {
    rejectUnknownKeys(scope, ['kind', 'projectId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: { kind: 'git-repairs', projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId') },
    };
  }
  if (scope.kind === 'execution-resources') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'featureId', 'batchId'], { operation }, 'scope');
    if (scope.featureId !== undefined && scope.batchId !== undefined) {
      planInvalidInput(operation, 'scope', 'featureId 与 batchId 不能同时存在', scope);
    }
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'execution-resources',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        ...(scope.featureId === undefined ? {} : { featureId: validateStableId(scope.featureId, { operation, entity: { type: 'feature' } }, 'scope.featureId') }),
        ...(scope.batchId === undefined ? {} : { batchId: validateStableId(scope.batchId, { operation, entity: { type: 'execution_batch' } }, 'scope.batchId') }),
      },
    };
  }
  if (scope.kind === 'planning-contexts') {
    rejectUnknownKeys(scope, ['kind', 'projectId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'planning-contexts',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
      },
    };
  }
  if (scope.kind === 'feature-planning-contexts') {
    rejectUnknownKeys(scope, ['kind', 'projectId', 'featureId'], { operation }, 'scope');
    return {
      rootIdentity: input.rootIdentity,
      scope: {
        kind: 'feature-planning-contexts',
        projectId: validateStableId(scope.projectId, { operation, entity: { type: 'project' } }, 'scope.projectId'),
        featureId: validateStableId(scope.featureId, { operation, entity: { type: 'feature' } }, 'scope.featureId'),
      },
    };
  }
  planInvalidInput(
    operation,
    'scope.kind',
    "必须是 'phases' / 'phase-graph' / 'features' / 'tasks' / 'budget-revisions' / 'task-attempts' / 'attempt-diagnostics' / 'run-work-sessions' / 'task-work-sessions' / 'task-approvals' / 'task-rework-chain' / 'feature-git-operations' / 'run-git-operations' / 'dispatch-queue' / 'dispatch-queue-batch' / 'dispatch-queue-feature' / 'execution-resources' / 'git-repairs' / 'planning-contexts' / 'feature-planning-contexts'",
    (scope as { kind?: unknown }).kind,
  );
}

function planBindingAsTrusted(binding: PlanListCursorBinding): PlanListCursorBinding {
  if (
    !isPlainObject(binding) ||
    typeof binding.rootIdentity !== 'string' ||
    !PLAN_ROOT_IDENTITY_PATTERN.test(binding.rootIdentity) ||
    !isPlainObject(binding.scope) ||
    (binding.scope.kind !== 'work-recording' &&
      binding.scope.kind !== 'phases' &&
      binding.scope.kind !== 'phase-graph' &&
      binding.scope.kind !== 'features' &&
      binding.scope.kind !== 'tasks' &&
      binding.scope.kind !== 'budget-revisions' &&
      binding.scope.kind !== 'task-attempts' &&
      binding.scope.kind !== 'attempt-diagnostics' &&
      binding.scope.kind !== 'run-work-sessions' &&
      binding.scope.kind !== 'task-work-sessions' &&
      binding.scope.kind !== 'task-approvals' &&
      binding.scope.kind !== 'task-rework-chain' &&
      binding.scope.kind !== 'feature-git-operations' &&
      binding.scope.kind !== 'run-git-operations' &&
      binding.scope.kind !== 'dispatch-queue-batch' &&
      binding.scope.kind !== 'dispatch-queue-feature' &&
      binding.scope.kind !== 'dispatch-queue' &&
      binding.scope.kind !== 'git-repairs' &&
      binding.scope.kind !== 'execution-resources' &&
      binding.scope.kind !== 'planning-contexts' &&
      binding.scope.kind !== 'feature-planning-contexts')
  ) {
    planScopeShapeError('必须由 createPlanListCursorBinding 构造');
  }
  return binding;
}

/** 根指纹：数据根身份前 16hex（游标不携带完整身份，更不携带路径）。 */
function planRootFingerprint(binding: PlanListCursorBinding): string {
  return binding.rootIdentity.slice(0, PLAN_ROOT_FINGERPRINT_LENGTH);
}

/** scope 指纹：层级 + 项目 + 父级（缺省父级用固定域值），跨项目/跨父级必然不匹配。 */
function planScopeFingerprint(scope: PlanListScope): string {
  let parent: string;
  switch (scope.kind) {
    case 'work-recording':
      parent = `${scope.parentKind}:${scope.parentId}:${scope.recordType}`;
      break;
    case 'dispatch-queue-batch':
      parent = `batch:${scope.batchId}`;
      break;
    case 'dispatch-queue-feature':
      parent = `feature:${scope.featureId}`;
      break;
    case 'execution-resources':
      parent = scope.featureId === undefined
        ? scope.batchId === undefined ? '-' : `batch:${scope.batchId}`
        : `feature:${scope.featureId}`;
      break;
    case 'git-repairs':
    case 'dispatch-queue':
    case 'phases':
    case 'planning-contexts':
      parent = '-';
      break;
    case 'phase-graph':
      parent = scope.phaseId;
      break;
    case 'features':
      parent = scope.phaseId;
      break;
    case 'feature-planning-contexts':
      parent = scope.featureId;
      break;
    case 'tasks':
    case 'feature-git-operations':
      parent = scope.featureId;
      break;
    case 'budget-revisions':
      parent = scope.batchId;
      break;
    case 'attempt-diagnostics':
      parent = scope.attemptId;
      break;
    case 'run-work-sessions':
    case 'run-git-operations':
      parent = scope.runId;
      break;
    default:
      parent = 'taskId' in scope ? scope.taskId : '-';
      break;
  }
  return createHash('sha256')
    .update(`shiploop:plan-list-scope:v1:${scope.kind}:${scope.projectId}:${parent}`, 'utf8')
    .digest('hex');
}

/**
 * 签发不透明续读游标（服务端内部调用）：plcur_v1_<base64url 紧凑 JSON>。
 * lastId 必须是合法稳定 ID（上一页末条记录 id）。
 */
export function encodePlanListCursor(lastId: string, binding: PlanListCursorBinding): string {
  const trusted = planBindingAsTrusted(binding);
  if (typeof lastId !== 'string' || !PLAN_CURSOR_STABLE_ID_PATTERN.test(lastId)) {
    throw new TypeError('encodePlanListCursor: lastId 必须是合法稳定 ID（服务端内部调用）');
  }
  const payload = JSON.stringify({
    v: PLAN_LIST_CURSOR_VERSION,
    id: lastId,
    root: planRootFingerprint(trusted),
    sk: planScopeFingerprint(trusted.scope),
  });
  return `${PLAN_LIST_CURSOR_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export interface DecodedPlanListCursor {
  readonly version: typeof PLAN_LIST_CURSOR_VERSION;
  readonly lastId: string;
}

/**
 * 解析并核验客户端回传的游标（unknown → {version,lastId}）。无法解码/非规范
 * base64url/未知键/未知版本/root 或 scope 指纹不符（跨项目/跨父级/跨根）一律
 * invalid_input(invalid_cursor)，绝不当作从零读取。
 */
export function decodePlanListCursor(
  cursor: unknown,
  binding: PlanListCursorBinding,
  operation: string = 'PlanListCursor.decode',
): DecodedPlanListCursor {
  const trusted = planBindingAsTrusted(binding);
  function invalid(received?: unknown): never {
    return planInvalidInput(operation, 'cursor', 'invalid_cursor', received);
  }
  if (typeof cursor !== 'string' || !cursor.startsWith(PLAN_LIST_CURSOR_PREFIX)) {
    invalid(cursor);
  }
  const body = cursor.slice(PLAN_LIST_CURSOR_PREFIX.length);
  if (body.length === 0 || !/^[A-Za-z0-9_-]+$/.test(body)) {
    invalid(cursor);
  }
  const bytes = Buffer.from(body, 'base64url');
  // 规范编码核验：拒绝填充、尾随数据及一切有歧义的宽容解码。
  if (Buffer.from(bytes).toString('base64url') !== body) {
    invalid(cursor);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    invalid(cursor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    invalid(cursor);
  }
  if (!isPlainObject(parsed)) {
    invalid(cursor);
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'v' && key !== 'id' && key !== 'root' && key !== 'sk') {
      invalid(cursor);
    }
  }
  if (parsed.v !== PLAN_LIST_CURSOR_VERSION) {
    invalid(cursor);
  }
  if (typeof parsed.id !== 'string' || !PLAN_CURSOR_STABLE_ID_PATTERN.test(parsed.id)) {
    invalid(cursor);
  }
  if (
    typeof parsed.root !== 'string' ||
    !/^[0-9a-f]{16}$/.test(parsed.root) ||
    parsed.root !== planRootFingerprint(trusted)
  ) {
    invalid(cursor);
  }
  if (
    typeof parsed.sk !== 'string' ||
    !/^[0-9a-f]{64}$/.test(parsed.sk) ||
    parsed.sk !== planScopeFingerprint(trusted.scope)
  ) {
    invalid(cursor);
  }
  return { version: PLAN_LIST_CURSOR_VERSION, lastId: parsed.id };
}

/* ---------------------------- 窄读取端口 ---------------------------- */

/** 列表读取请求：排他键集下界（'' = 从头）与有界页大小（应用层已校验）。 */
export interface PlanListRequest {
  readonly afterId: string | null;
  readonly limit: number;
}

/** 列表存储页：nextId 为用满 limit 时的末条 id（供应用层编码游标），否则 null。 */
export interface PlanRecordPage<T> {
  readonly records: readonly T[];
  readonly nextId: string | null;
}

/**
 * 计划层级列表窄读取端口（§6.6）：可见范围谓词随查询下推 SQL（先收窄再分页），
 * 稳定 id 升序键集分页；visibility 非法形状为编程错误（TypeError）。父级跨项目
 * 或不存在均返回空页（与「空父级」不可区分，不泄漏存在性）。
 */
export interface PlanHierarchyReadStore {
  listPhaseRecords(
    visibility: unknown,
    projectId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<PhaseRecord>;
  listFeatureRecords(
    visibility: unknown,
    projectId: unknown,
    phaseId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<FeatureRecord>;
  listTaskRecords(
    visibility: unknown,
    projectId: unknown,
    featureId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<TaskRecord>;
}

/** Feature 计划一致读视图：Feature + 全部 Task + 全部依赖边（单一读事务内取得）。 */
export interface FeaturePlanView {
  readonly feature: FeatureRecord;
  readonly tasks: readonly TaskRecord[];
  readonly dependencies: readonly TaskDependencyRecord[];
}

/**
 * 计划详情窄读取端口：readFeaturePlanView 必须在单一 SQLite DEFERRED 读事务
 * 内取得 Feature + Task + 边（并发修订只能观察到完整修订前或修订后，绝不出现
 * 新 Task 配旧边/旧摘要的混合状态）；嵌套于写事务内调用是编程错误（TypeError）。
 * 未命中返回 undefined（可见性折叠由应用层统一为 not_found）。
 */
export interface PlanDetailReadStore {
  readPhaseRecord(phaseId: unknown): PhaseRecord | undefined;
  readPhaseGraphView(projectId: unknown, phaseId: unknown): PhaseFeatureGraphView | undefined;
  readTaskRecord(taskId: unknown): TaskRecord | undefined;
  readFeaturePlanView(featureId: unknown): FeaturePlanView | undefined;
}

/* ---------------------- P03-2 / F-002 计划审批决策查询 ---------------------- */

/**
 * 计划审批决策查询操作身份（Core 查询面）。Host 传输接线与线协议同步属
 * P03-2 / F-007（与命令面 v4 内增量同一纪律：能力位复用 project.read，
 * 不新增查询能力位）。
 */
export const PLAN_APPROVAL_QUERY_OPERATION = 'features.approvals' as const;

/** 公开计划审批决策记录（时间 ISO UTC；与 PlanApprovalRecord 字段一一对应）。 */
export interface PublicPlanApprovalRecord {
  readonly id: string;
  readonly projectId: string;
  /** 受审批主体稳定 ID（feature_plan 时为 Feature 稳定 ID）。 */
  readonly subjectId: string;
  readonly subjectType: PlanApprovalRecord['subjectType'];
  readonly subjectDigest: string;
  /** 决策绑定的适用检查政策身份摘要（P03-2 / F-003；v7 遗留行为 null）。 */
  readonly checkPolicyDigest: string | null;
  readonly status: PlanApprovalRecord['status'];
  readonly decisionActor: string | null;
  readonly reason: string | null;
  readonly decidedAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicPlanApprovalRecord(record: PlanApprovalRecord): PublicPlanApprovalRecord {
  return {
    id: record.id,
    projectId: record.projectId,
    subjectId: record.subjectId,
    subjectType: record.subjectType,
    subjectDigest: record.subjectDigest,
    checkPolicyDigest: record.checkPolicyDigest,
    status: record.status,
    decisionActor: record.decisionActor,
    reason: record.reason,
    decidedAt:
      record.decidedAtUtcMs === null ? null : new Date(record.decidedAtUtcMs).toISOString(),
    revision: record.revision,
    createdAt: new Date(record.createdAtUtcMs).toISOString(),
    updatedAt: new Date(record.updatedAtUtcMs).toISOString(),
  };
}

/** 决策记录查询项：附带「是否绑定当前 planDigest」标记（当前决定 vs 历史决定）。 */
export interface PublicPlanApprovalDecision extends PublicPlanApprovalRecord {
  /** subjectDigest 等于当前 planDigest 时为 true（每摘要至多一条决策）。 */
  readonly current: boolean;
}

/**
 * features.approvals → {feature, currentDecision, decisions, validity}：Feature、
 * 全部决策记录与全局/项目当前配置来自同一 DEFERRED 一致读视图；
 * feature.planStatus 是权威审批状态（拒绝后绝非 approved），decisions[].current
 * 按 planDigest 绑定区分当前决定与历史决定，不把拒绝显示为已批准；
 * validity（P03-2 / F-003）是同一视图的 fail-closed 有效批准评估
 * （evaluatePlanApprovalValidity 纯规则），携带明确过期原因。
 */
export interface FeatureApprovalsResult {
  readonly feature: PublicFeatureRecord;
  /** 当前决定（绑定当前 planDigest 的记录）；尚无决定时为 null。 */
  readonly currentDecision: PublicPlanApprovalDecision | null;
  /** 全部决策记录（含历史；稳定排序：decisionTime → id）。 */
  readonly decisions: readonly PublicPlanApprovalDecision[];
  /** 有效批准核验（同一权威视图；明确过期原因；批准不是启动授权）。 */
  readonly validity: PlanApprovalValidity;
}

/**
 * 一致读视图内的配置 scope 快照（P03-2 / F-003）：scopeRevision + 已校验
 * payload；供有效批准核验在同一视图内计算当前适用检查政策身份。
 */
export interface SettingsScopeSnapshot {
  readonly scopeRevision: number;
  readonly payload: SettingsPayload;
}

/**
 * Feature + 决策记录 + 全局/项目当前配置的一致读视图（单一 DEFERRED 读
 * 事务内取得；配置缺失为 null，与「项目存在但无覆盖」同一语义）。
 */
export interface FeatureApprovalsView {
  readonly feature: FeatureRecord;
  readonly approvals: readonly PlanApprovalRecord[];
  /** 当前计划任务数（零 Task 不可执行；有效批准核验输入）。 */
  readonly taskCount: number;
  readonly settings: {
    readonly global: SettingsScopeSnapshot | null;
    readonly project: SettingsScopeSnapshot | null;
  };
}

/**
 * 计划审批决策窄读取端口：readFeatureApprovalsView 在单一 DEFERRED 读事务内
 * 取得 Feature 行与全部决策记录（并发决策/修订只能观察到完整前后状态）；
 * 未命中返回 undefined（可见性折叠由应用层统一为 not_found）。
 */
export interface PlanApprovalReadStore {
  readFeatureApprovalsView(featureId: unknown): FeatureApprovalsView | undefined;
}

/** F-006 计划查询读取门面：层级列表 + 详情窄读取端口的并集；P03-2 / F-002 起含审批决策读取。 */
export interface PlanQueryReadStore
  extends PlanHierarchyReadStore,
    PlanDetailReadStore,
    PlanApprovalReadStore {}
