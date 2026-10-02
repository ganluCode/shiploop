/**
 * F-002 最小 StateStore 窄契约（ports 契约层）：项目与全局/项目当前配置。
 *
 * 设计依据：core-design/03 §1-3 与 core-design/11 §3。
 *
 * 契约要点：
 * - 稳定 ID（应用侧生成，UUID）、UTC 毫秒时间、revision（CAS 并发计数）与
 *   schemaVersion（payload 数据格式版本）分开表达，互不替代；
 * - 接口输入一律为 unknown：调用方与实现方之间的边界必须做运行时校验
 *   （本文件的 validate* 函数），TypeScript 类型不替代校验；
 * - 全局配置为单例（id=global），项目配置每项目一条；重复创建返回 conflict，
 *   不做默默覆盖；更新一律携带 expectedRevision；
 * - P01-3 / F-005 起新增仓库绑定窄契约：RepositoryBindingRecord、
 *   createProjectWithRepositoryBinding（项目+绑定原子组合创建，canonicalPath
 *   唯一幂等复用）与 getRepositoryBinding；仓库/文件检查不属本端口，由
 *   RepositoryInspector（ports/repository-inspector.ts）在写事务之外完成；
 * - 不提前实现：配置合并、模型路由、Task 策略复制、凭据解析、
 *   配置历史版本表（设计明确不建）。
 */
import { listStrategyEntries, validateSettingsPayload } from './settings-schema.js';
import type { SettingsPayload } from './settings-schema.js';
import {
  normalizeLabels,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateExpectedRevision,
  validatePositiveInteger,
  validateProjectDescription,
  validateProjectDisplayName,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';
import type { StorageEntityRef } from './errors.js';

/** 全局当前配置单例的稳定记录 ID（core-design/11 §3：全局单例 id=global）。 */
export const GLOBAL_SETTINGS_ID = 'global';

/**
 * 项目元数据更新事件类型（F-006）：状态事件审计切片使用的稳定 event_type。
 * 事件只保存操作/实体/修订身份与**脱敏字段摘要**（变更字段名），不含字段值。
 */
export const PROJECT_METADATA_UPDATED_EVENT_TYPE = 'project.metadata_updated';

/**
 * 当前配置更新事件类型（F-010）：全局/项目当前配置的 CAS 更新在同一短事务内
 * 追加一条对应类型的 state_events 脱敏审计记录（见契约文档 §4.4/§6.3）。
 * 首次创建为 insert-only，不写审计记录（与 createProject 不写事件一致）。
 */
export const GLOBAL_SETTINGS_UPDATED_EVENT_TYPE = 'settings.global_updated';
export const PROJECT_SETTINGS_UPDATED_EVENT_TYPE = 'settings.project_updated';

/**
 * P01-3 已写入的聚合类型（设计 11 §9）：F-006 写 `project`，F-010 写
 * `global_settings`/`project_settings`。DDL 只要求非空，以便执行域表加入新聚合时
 * 无需重建审计表；写入方仍由本契约限定取值。
 */
export type StateEventAggregateType = 'project' | 'global_settings' | 'project_settings';

/** 项目生命周期（core-design/02 §生命周期：active→archiving→archived；删除自 archived 起经 deleting）。 */
export type ProjectStatus = 'active' | 'archiving' | 'archived' | 'deleting';

export interface ProjectRecord {
  readonly id: string;
  readonly displayName: string;
  /**
   * 可选项目说明。
   * 补充依据：core-design/11 §3 的 projects 字段字典未列 description；本契约按
   * Feature 验收要求（“后续 PRD 要求的可选 description”）补充该可选字段，与
   * phases/features/tasks 均携带可选 description 的既有字典保持一致。F-003 建表
   * 时落地为可空列；默认 null，不参与 ID 或物理路径推导。
   */
  readonly description: string | null;
  readonly status: ProjectStatus;
  /** 跨项目筛选标签；默认空数组，已按 trim/NFC/ASCII 小写规范化并去重。 */
  readonly labels: readonly string[];
  /** 仓库绑定记录；注册流程落地前恒为 null。 */
  readonly repositoryBindingId: string | null;
  /** CAS 并发计数：每次成功写入递增。 */
  readonly revision: number;
  /** 创建时间，UTC 毫秒整数。 */
  readonly createdAtUtcMs: number;
  /** 更新时间，UTC 毫秒整数。 */
  readonly updatedAtUtcMs: number;
}

export interface CreateProjectInput {
  readonly displayName: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
}

/** 校验并规范化后的创建输入：labels 已规范化（默认 []），description 缺席为 null。 */
export interface ValidatedCreateProjectInput {
  readonly displayName: string;
  readonly description: string | null;
  readonly labels: string[];
}

export function validateCreateProjectInput(value: unknown, operation: string): ValidatedCreateProjectInput {
  const context: ValidationContext = { operation, entity: { type: 'project' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['displayName', 'description', 'labels'], context, 'input');
  return {
    displayName: validateProjectDisplayName(object.displayName, context, 'displayName'),
    description: validateProjectDescription(object.description, context, 'description') ?? null,
    labels: normalizeLabels(object.labels, context),
  };
}

export interface UpdateProjectInput {
  readonly expectedRevision: number;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
}

/** 元数据更新（标签/名称/说明）与配置走同一 CAS 规则；至少提供一个待更新字段。 */
export interface ValidatedUpdateProjectInput {
  readonly expectedRevision: number;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly labels?: string[];
}

export function validateUpdateProjectInput(value: unknown, operation: string): ValidatedUpdateProjectInput {
  const context: ValidationContext = { operation, entity: { type: 'project' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['expectedRevision', 'displayName', 'description', 'labels'], context, 'input');
  const expectedRevision = validateExpectedRevision(object.expectedRevision, context);
  const result: {
    expectedRevision: number;
    displayName?: string;
    description?: string | null;
    labels?: string[];
  } = { expectedRevision };
  let hasField = false;
  if (object.displayName !== undefined) {
    result.displayName = validateProjectDisplayName(object.displayName, context, 'displayName');
    hasField = true;
  }
  if (object.description !== undefined) {
    result.description = validateProjectDescription(object.description, context, 'description') ?? null;
    hasField = true;
  }
  if (object.labels !== undefined) {
    result.labels = normalizeLabels(object.labels, context);
    hasField = true;
  }
  if (!hasField) {
    throw validationError(context, 'input', '必须至少提供 displayName、description 或 labels 之一');
  }
  return result;
}

/**
 * 从已校验的更新输入派生**脱敏**变更字段名（顺序稳定；只含字段名，不含字段值），
 * 供状态事件 payload 使用。注册、编辑与审计共用同一派生，不另立字段名集合。
 */
export function projectMetadataChangedFields(
  input: ValidatedUpdateProjectInput,
): readonly string[] {
  const fields: string[] = [];
  if (input.displayName !== undefined) {
    fields.push('displayName');
  }
  if (input.description !== undefined) {
    fields.push('description');
  }
  if (input.labels !== undefined) {
    fields.push('labels');
  }
  return fields;
}

/**
 * P01-3 / F-007 项目标签筛选、有限分页与项目层计数窄契约（设计 11 §10、设计 08 §2）。
 *
 * 语义与不变量：
 * - `match='any'`：项目标签与请求标签**任一**命中；`match='all'`：请求标签**全部**
 *   出现在项目标签中。空标签数组表示**不加标签约束**（返回全部可见项目），不区分模式；
 * - 查询参数一律经 `validateProjectListFilter` 运行时校验：标签复用 F-002 的
 *   `normalizeLabels`（筛选与注册/编辑共用同一规范化规则，重复规范化输入去重），
 *   非法 match/limit/cursor/未知键在进入 SQL 之前拒绝，实现必须以绑定参数查询；
 * - 有限分页：默认 `PROJECT_LIST_DEFAULT_LIMIT`、上限 `PROJECT_LIST_MAX_LIMIT`，按
 *   稳定 `id` 升序排序，游标为上一页最后一条项目 id，跨页不重复/遗漏；
 * - 标签计数按项目去重（同一项目同标签只计一次），只统计项目层，不与其他领域层级相加；
 *   可见范围与 `listProjects` 相同（P01-3 无授权收窄，后续授权过滤时两者共用同一谓词）。
 *
 * 本契约不实现按标签启动 Batch，也不提供 Phase/Feature/Task 标签查询（T32 全量由后续）。
 */
export type ProjectLabelMatchMode = 'any' | 'all';

export interface ProjectListFilter {
  readonly match?: ProjectLabelMatchMode;
  readonly labels?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

/** 项目列表分页默认每页条目数与最大每页条目数（有限默认值 + 硬上限）。 */
export const PROJECT_LIST_DEFAULT_LIMIT = 50;
export const PROJECT_LIST_MAX_LIMIT = 200;

export interface ValidatedProjectListFilter {
  readonly match: ProjectLabelMatchMode;
  readonly labels: string[];
  readonly limit: number;
  readonly cursor?: string;
}

/** 项目分页页：游标为下一页起始（上一页最后一条 id），无更多为 null。 */
export interface ProjectPage {
  readonly records: readonly ProjectRecord[];
  readonly nextCursor: string | null;
}

/** 项目层标签计数：同一项目同标签只计一次，不跨层级求和。 */
export interface ProjectLabelCount {
  /** 已按 F-002 规则规范化并去重的标签。 */
  readonly label: string;
  /** 含该标签的项目数（同一项目同标签只计一次）。 */
  readonly projectCount: number;
}

export function validateProjectListFilter(
  value: unknown,
  operation: string,
): ValidatedProjectListFilter {
  const context: ValidationContext = { operation };
  if (value === undefined) {
    return { match: 'any', labels: [], limit: PROJECT_LIST_DEFAULT_LIMIT };
  }
  const object = requirePlainObject(value, context, 'filter');
  rejectUnknownKeys(object, ['match', 'labels', 'limit', 'cursor'], context, 'filter');
  let match: ProjectLabelMatchMode = 'any';
  if (object.match !== undefined) {
    if (object.match !== 'any' && object.match !== 'all') {
      throw validationError(
        context,
        'filter.match',
        "必须是 'any' 或 'all'（任一/全部标签匹配）",
        object.match,
      );
    }
    match = object.match;
  }
  const labels = normalizeLabels(object.labels, context, 'filter.labels');
  let limit = PROJECT_LIST_DEFAULT_LIMIT;
  if (object.limit !== undefined) {
    if (
      typeof object.limit !== 'number' ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > PROJECT_LIST_MAX_LIMIT
    ) {
      throw validationError(
        context,
        'filter.limit',
        `必须是 1..${PROJECT_LIST_MAX_LIMIT} 的整数（每页上限）`,
        object.limit,
      );
    }
    limit = object.limit;
  }
  if (object.cursor !== undefined) {
    return { match, labels, limit, cursor: validateStableId(object.cursor, context, 'filter.cursor') };
  }
  return { match, labels, limit };
}

interface SettingsRecordBase {
  readonly id: string;
  /** payload 的数据格式版本（与 payload.schemaVersion 一致，单独表达供存储/迁移门槛使用）。 */
  readonly schemaVersion: number;
  /** 经 schemaVersion 结构校验的当前配置；绝不保存或返回未校验 JSON。 */
  readonly payload: SettingsPayload;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

/** 全局当前配置：单例，id 恒为 GLOBAL_SETTINGS_ID。 */
export interface GlobalSettingsRecord extends SettingsRecordBase {}

/** 项目当前配置：每项目一条，严格按 projectId 隔离。 */
export interface ProjectSettingsRecord extends SettingsRecordBase {
  readonly projectId: string;
}

export interface ValidatedPutSettingsInput {
  readonly payload: SettingsPayload;
}

export function validatePutSettingsInput(
  value: unknown,
  operation: string,
  entity?: StorageEntityRef,
): ValidatedPutSettingsInput {
  const context: ValidationContext = { operation, entity };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['payload'], context, 'input');
  return { payload: validateSettingsPayload(object.payload, context) };
}

export interface ValidatedUpdateSettingsInput extends ValidatedPutSettingsInput {
  readonly expectedRevision: number;
}

export function validateUpdateSettingsInput(
  value: unknown,
  operation: string,
  entity?: StorageEntityRef,
): ValidatedUpdateSettingsInput {
  const context: ValidationContext = { operation, entity };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['expectedRevision', 'payload'], context, 'input');
  return {
    expectedRevision: validateExpectedRevision(object.expectedRevision, context),
    payload: validateSettingsPayload(object.payload, context),
  };
}

/**
 * 配置变更的脱敏摘要（F-010）：state_events payload 只含 schemaVersion 与
 * 提供的策略键名/政策段名（如 `defaultStrategy`、`modelMap.low`、
 * `executionLimits`），绝不包含策略值、credentialRef/endpointRef 引用值、
 * 模型名或任何合成秘密。写入与审计共用同一派生，不另立第二套摘要规则。
 */
export interface SettingsChangeSummary {
  readonly schemaVersion: number;
  /** 本次 payload 实际提供的策略键名（字段路径去掉 `payload.strategies.` 前缀）。 */
  readonly strategies: readonly string[];
  /** 本次 payload 实际提供的政策段名（白名单内键名）。 */
  readonly policies: readonly string[];
}

const STRATEGY_FIELD_PREFIX = 'payload.strategies.';

export function settingsChangeSummary(payload: SettingsPayload): SettingsChangeSummary {
  return {
    schemaVersion: payload.schemaVersion,
    strategies: listStrategyEntries(payload.strategies).map((entry) =>
      entry.field.startsWith(STRATEGY_FIELD_PREFIX) ? entry.field.slice(STRATEGY_FIELD_PREFIX.length) : entry.field,
    ),
    policies: Object.keys(payload.policies ?? {}),
  };
}

/**
 * 项目当前配置写入的一致性前置条件（F-010；契约文档 §4.4）。
 *
 * 项目覆盖的写入校验（有效配置合并 + 能力兼容）依赖「全局当前配置 + 新 payload」
 * 的一致性视图：应用服务在写事务之外读取全局配置，本前置条件把读取时看到的
 * 全局 revision 随写入一并传入，由适配器在**同一写事务内**核对——核对不一致
 * （全局已被并发更新/创建/删除）时返回 conflict（reason='stale_dependency'），
 * 不提交基于陈旧依赖校验过的结果。`null` 表示校验时全局配置不存在，写入时点
 * 仍须不存在。
 */
export interface SettingsWriteConsistency {
  readonly globalRevision: number | null;
}

function validateSettingsWriteConsistency(
  value: unknown,
  operation: string,
  entity?: StorageEntityRef,
): SettingsWriteConsistency | undefined {
  if (value === undefined) {
    return undefined;
  }
  const context: ValidationContext = { operation, entity };
  const object = requirePlainObject(value, context, 'input.consistency');
  rejectUnknownKeys(object, ['globalRevision'], context, 'input.consistency');
  if (object.globalRevision === null) {
    return { globalRevision: null };
  }
  return {
    globalRevision: validatePositiveInteger(object.globalRevision, context, 'input.consistency.globalRevision'),
  };
}

/** 项目当前配置创建输入（端口形态）：payload + 可选一致性前置条件。 */
export interface ValidatedCreateProjectSettingsInput extends ValidatedPutSettingsInput {
  readonly consistency?: SettingsWriteConsistency;
}

export function validateCreateProjectSettingsInput(
  value: unknown,
  operation: string,
  entity?: StorageEntityRef,
): ValidatedCreateProjectSettingsInput {
  const context: ValidationContext = { operation, entity };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['payload', 'consistency'], context, 'input');
  return {
    payload: validateSettingsPayload(object.payload, context),
    consistency: validateSettingsWriteConsistency(object.consistency, operation, entity),
  };
}

/** 项目当前配置更新输入（端口形态）：CAS + payload + 可选一致性前置条件。 */
export interface ValidatedUpdateProjectSettingsInput extends ValidatedUpdateSettingsInput {
  readonly consistency?: SettingsWriteConsistency;
}

export function validateUpdateProjectSettingsInput(
  value: unknown,
  operation: string,
  entity?: StorageEntityRef,
): ValidatedUpdateProjectSettingsInput {
  const context: ValidationContext = { operation, entity };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, ['expectedRevision', 'payload', 'consistency'], context, 'input');
  return {
    expectedRevision: validateExpectedRevision(object.expectedRevision, context),
    payload: validateSettingsPayload(object.payload, context),
    consistency: validateSettingsWriteConsistency(object.consistency, operation, entity),
  };
}

/** 项目与初始项目当前配置的原子组合创建结果（F-007）。 */
export interface ProjectWithInitialSettingsRecord {
  readonly project: ProjectRecord;
  readonly settings: ProjectSettingsRecord;
}

/**
 * 仓库绑定记录（P01-3 / F-005；设计 11 §3 repository_bindings 的应用侧形态）。
 *
 * - canonicalPath 为 realpath 规范化后的仓库根，全库唯一（符号链接别名解析到
 *   同一值；remote 不作为唯一身份，同 remote 不同 clone 分别注册）；
 * - repoIdentity 为稳定本地身份（ports/repository-inspector.ts 的
 *   deriveRepoIdentity 派生），不含本地路径原文；
 * - revision 为绑定记录的 CAS 并发计数，bindingRevision 为仓库绑定自身的并发
 *   计数（设计 11 §3），两者分开表达；
 * - 仓库检查的瞬时事实（headCommit/脏状态等）不持久化：绑定只保存身份与位置，
 *   运行时状态每次按需重新只读检查。
 */
export interface RepositoryBindingRecord {
  readonly id: string;
  readonly projectId: string;
  /** realpath 规范化后的仓库根（全库唯一）。 */
  readonly canonicalPath: string;
  /** Git 公共元数据目录（可空；linked worktree 时指向主 checkout 的 .git）。 */
  readonly gitCommonDir: string | null;
  /** 稳定本地仓库身份（remote 不参与）。 */
  readonly repoIdentity: string;
  /** 绑定记录的 CAS 并发计数。 */
  readonly revision: number;
  /** 仓库绑定自身的并发计数（设计 11 §3 binding_revision）。 */
  readonly bindingRevision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

/** 仓库绑定创建输入：由只读仓库检查（F-004）在写事务之外产出并传入。 */
export interface CreateRepositoryBindingInput {
  readonly canonicalPath: string;
  readonly gitCommonDir?: string | null;
  readonly repoIdentity: string;
}

/** 校验后的绑定创建输入：gitCommonDir 缺席为 null。 */
export interface ValidatedCreateRepositoryBindingInput {
  readonly canonicalPath: string;
  readonly gitCommonDir: string | null;
  readonly repoIdentity: string;
}

/** 规范化后的仓库路径纯校验：不含 NUL 的非空 POSIX 绝对路径（首版仅 macOS）。 */
function validateCanonicalAbsolutePath(
  value: unknown,
  context: ValidationContext,
  field: string,
): string {
  const path = requireNonEmptyString(value, context, field);
  if (path.includes('\0')) {
    throw validationError(context, field, '不允许包含 NUL 字节');
  }
  if (!path.startsWith('/')) {
    throw validationError(
      context,
      field,
      '必须是 realpath 规范化后的 POSIX 绝对路径（由只读仓库检查产出，调用方不得拼接）',
    );
  }
  return path;
}

export function validateCreateRepositoryBindingInput(
  value: unknown,
  operation: string,
): ValidatedCreateRepositoryBindingInput {
  const context: ValidationContext = { operation, entity: { type: 'repository_binding' } };
  const object = requirePlainObject(value, context, 'binding');
  rejectUnknownKeys(object, ['canonicalPath', 'gitCommonDir', 'repoIdentity'], context, 'binding');
  const gitCommonDir = object.gitCommonDir;
  return {
    canonicalPath: validateCanonicalAbsolutePath(object.canonicalPath, context, 'canonicalPath'),
    gitCommonDir:
      gitCommonDir === undefined || gitCommonDir === null
        ? null
        : validateCanonicalAbsolutePath(gitCommonDir, context, 'gitCommonDir'),
    repoIdentity: requireNonEmptyString(object.repoIdentity, context, 'repoIdentity'),
  };
}

/**
 * 项目与仓库绑定的原子组合创建结果（F-005）：
 * - registered：本次创建了新项目与新绑定；
 * - already_exists：同一 canonicalPath 已注册，返回既有项目与绑定，
 *   不新增行，也不覆盖既有名称/描述/标签（幂等复用，含符号链接别名）。
 */
export type ProjectWithRepositoryBindingResult =
  | {
      readonly status: 'registered';
      readonly project: ProjectRecord;
      readonly binding: RepositoryBindingRecord;
    }
  | {
      readonly status: 'already_exists';
      readonly project: ProjectRecord;
      readonly binding: RepositoryBindingRecord;
    };

/**
 * 最小 StateStore 端口：项目与当前配置的创建/读取/CAS 更新。
 * 所有方法在持久化前完成输入运行时校验；校验失败不得产生任何持久化副作用。
 * 实现者：F-006 起的 SQLite 适配器；语义基线见 test/storage-contracts.test.ts。
 */
export interface StateStore {
  createProject(input: unknown): Promise<ProjectRecord>;
  /** 不存在返回 StorageError(kind='not_found')。 */
  getProject(projectId: string): Promise<ProjectRecord>;
  /**
   * 元数据 CAS 更新；过期 expectedRevision 返回 conflict，原记录不变。
   *
   * P01-3 / F-006 起：成功更新会在**同一短事务内**追加一条 state_events 审计记录
   * （event_type=`project.metadata_updated`，aggregate/项目/写后 revision 身份 + 脱敏的
   * 变更字段名摘要，sequence 数据库内单调分配），使“变更记录”与元数据原子一致；
   * 注入记录写入失败时元数据与 revision 一并回滚，不产生半条记录。校验失败/过期 revision
   * 不写记录。诊断 logger 不充当权威记录。
   */
  updateProject(projectId: string, input: unknown): Promise<ProjectRecord>;

  /**
   * 项目与初始项目当前配置的原子组合创建（F-007）：
   * 两个输入都在任何持久化副作用之前完成运行时校验；两者在同一业务原子操作内
   * 成功或一起回滚——第二步失败时不留下残留项目或配置（无半条业务记录）。
   */
  createProjectWithInitialSettings(
    project: unknown,
    settings: unknown,
  ): Promise<ProjectWithInitialSettingsRecord>;

  /**
   * 项目与仓库绑定的原子组合创建（P01-3 / F-005）：
   * - 两个输入都在任何持久化副作用之前完成运行时校验；项目与绑定在同一短事务
   *   内保存，绑定写入失败时项目一并回滚（无孤立项目或绑定）；
   * - canonicalPath 全库唯一：同一规范路径（含符号链接别名解析结果）已注册时
   *   返回 already_exists 与既有项目/绑定，不新增行、不覆盖既有元数据；
   *   唯一约束冲突时做有界核对（重读一次），核对到既有绑定则复用，否则原错误
   *   继续抛出；
   * - projectId 由应用侧生成（UUID），不由 displayName、remote 或目录标题推导。
   */
  createProjectWithRepositoryBinding(
    project: unknown,
    binding: unknown,
  ): Promise<ProjectWithRepositoryBindingResult>;

  /**
   * 按 projectId 返回完整仓库绑定；未知项目/无绑定返回 not_found。
   */
  getRepositoryBinding(projectId: string): Promise<RepositoryBindingRecord>;

  /**
   * F-007：按标签任一/全部筛选、按稳定 id 升序有界分页列出项目。
   *
   * 参数经 `validateProjectListFilter` 运行时校验（标签复用 `normalizeLabels`），
   * 实现以绑定参数查询，绝不拼接标签原文；空标签数组返回全部可见项目。游标为上一页
   * 返回的 `nextCursor`（最后一条项目 id）。非法参数在任何 SQL 之前拒绝。
   */
  listProjects(filter?: unknown): Promise<ProjectPage>;

  /**
   * F-007：项目层标签去重计数（同一项目同标签只计一次），只统计项目层，
   * 不与其他领域层级（Phase/Feature/Task）相加；可见范围与 `listProjects` 相同。
   */
  countProjectLabels(): Promise<readonly ProjectLabelCount[]>;

  /** 全局单例创建；已存在返回 conflict 而非覆盖。 */
  createGlobalSettings(input: unknown): Promise<GlobalSettingsRecord>;
  getGlobalSettings(): Promise<GlobalSettingsRecord>;
  /**
   * 全局当前配置 CAS 更新；过期 expectedRevision 返回 conflict，原记录不变。
   *
   * P01-3 / F-010 起：成功更新在同一短事务内追加一条 state_events 脱敏审计记录
   * （event_type=`settings.global_updated`，aggregate_type='global_settings'，
   * project_id=NULL，payload 只含 schemaVersion 与策略键名/政策段名摘要），
   * 注入记录写入失败时配置与 revision 一并回滚。
   */
  updateGlobalSettings(input: unknown): Promise<GlobalSettingsRecord>;

  /**
   * 每项目一条；项目不存在返回 not_found，重复创建返回 conflict。
   * P01-3 / F-010 起接受可选 `consistency` 一致性前置条件：提供时在同一写事务内
   * 核对全局当前配置 revision 与校验时所读一致，不一致返回 conflict
   * （reason='stale_dependency'），不提交基于陈旧依赖校验过的写入。
   */
  createProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord>;
  getProjectSettings(projectId: string): Promise<ProjectSettingsRecord>;
  /**
   * 项目当前配置 CAS 更新；过期 expectedRevision 返回 conflict，原记录不变。
   *
   * P01-3 / F-010 起：成功更新在同一短事务内追加一条 state_events 脱敏审计记录
   * （event_type=`settings.project_updated`，aggregate_type='project_settings'，
   * project_id 必填，payload 摘要同上）；接受可选 `consistency` 前置条件
   * （语义同 createProjectSettings）；任何失败整组回滚，不产生半条记录。
   */
  updateProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord>;
}
