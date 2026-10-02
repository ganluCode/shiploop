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
 * - 不提前实现：仓库注册流程、配置合并、模型路由、Task 策略复制、凭据解析、
 *   配置历史版本表（设计明确不建）。
 */
import { validateSettingsPayload } from './settings-schema.js';
import type { SettingsPayload } from './settings-schema.js';
import {
  normalizeLabels,
  optionalNullableString,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateExpectedRevision,
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
    displayName: requireNonEmptyString(object.displayName, context, 'displayName'),
    description: optionalNullableString(object.description, context, 'description') ?? null,
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
    result.displayName = requireNonEmptyString(object.displayName, context, 'displayName');
    hasField = true;
  }
  if (object.description !== undefined) {
    result.description = optionalNullableString(object.description, context, 'description') ?? null;
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

  /** 全局单例创建；已存在返回 conflict 而非覆盖。 */
  createGlobalSettings(input: unknown): Promise<GlobalSettingsRecord>;
  getGlobalSettings(): Promise<GlobalSettingsRecord>;
  updateGlobalSettings(input: unknown): Promise<GlobalSettingsRecord>;

  /** 每项目一条；项目不存在返回 not_found，重复创建返回 conflict。 */
  createProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord>;
  getProjectSettings(projectId: string): Promise<ProjectSettingsRecord>;
  updateProjectSettings(projectId: string, input: unknown): Promise<ProjectSettingsRecord>;
}
