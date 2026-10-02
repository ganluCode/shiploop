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
import { validateSettingsPayload } from './settings-schema.js';
import type { SettingsPayload } from './settings-schema.js';
import {
  normalizeLabels,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateExpectedRevision,
  validateProjectDescription,
  validateProjectDisplayName,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';
import type { StorageEntityRef } from './errors.js';

/** 全局当前配置单例的稳定记录 ID（core-design/11 §3：全局单例 id=global）。 */
export const GLOBAL_SETTINGS_ID = 'global';

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
  /** 元数据 CAS 更新；过期 expectedRevision 返回 conflict，原记录不变。 */
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
   * 按项目读取仓库绑定；项目不存在或尚无绑定返回 not_found。
   */
  getRepositoryBinding(projectId: string): Promise<RepositoryBindingRecord>;

  /** 全局单例创建；已存在返回 conflict 而非覆盖。 */
  createGlobalSettings(input: unknown): Promise<GlobalSettingsRecord>;
  getGlobalSettings(): Promise<GlobalSettingsRecord>;
  updateGlobalSettings(input: unknown): Promise<GlobalSettingsRecord>;

  /** 每项目一条；项目不存在返回 not_found，重复创建返回 conflict。 */
  createProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord>;
  getProjectSettings(projectId: string): Promise<ProjectSettingsRecord>;
  updateProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord>;
}
