/**
 * F-002 端口输入的运行时校验原语（ports 契约层，纯函数，无 I/O）。
 *
 * 设计依据：core-design/03 §1（ID 应用侧生成、JSON 运行时校验、revision CAS）
 * 与 core-design/11 §10（标签规范化：trim、Unicode NFC、ASCII 小写、实体内去重）。
 *
 * 约定：
 * - TypeScript 类型不能替代运行时校验：所有跨越端口边界的外部 JSON
 *   （unknown）必须先经本模块断言后才允许进入任何持久化路径；
 * - 校验失败抛 StorageError(kind='validation')，details 携带 field/reason，
 *   不回显完整输入值（最多记录 receivedType），避免泄漏 payload 或凭据内容；
 * - 校验器是纯函数：不读取时钟/文件系统/网络，失败天然没有持久化副作用。
 */
import { StorageError } from './errors.js';
import type { StorageEntityRef } from './errors.js';

export interface ValidationContext {
  /** 发生校验的端口操作名，如 'StateStore.createProject'。 */
  readonly operation: string;
  /** 适用实体身份（可选，创建前可能尚无 id）。 */
  readonly entity?: StorageEntityRef;
}

export function describeValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

export function validationError(
  context: ValidationContext,
  field: string,
  reason: string,
  received?: unknown,
): StorageError {
  return new StorageError('validation', context.operation, `${context.operation}: ${field} ${reason}`, {
    entity: context.entity,
    details: {
      field,
      reason,
      ...(received !== undefined ? { receivedType: describeValueType(received) } : {}),
    },
  });
}

/**
 * 项目/实体元数据的长度与数量上限（P01-3 实施契约）。
 *
 * 设计未给出具体数值；这些值记录于 `docs/p01-3-application-contract.md` §3（复用规则）
 * 并请求确认，注册、元数据编辑与查询筛选**共用同一套上限**，任何入口不得另立数值。
 * 长度以 Unicode 码点计（emoji、组合字符不被错误截断判断），并先做标签规范化。
 */
export const PROJECT_DISPLAY_NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 10_000;
export const LABEL_MAX_LENGTH = 64;
export const LABELS_MAX_COUNT = 50;

/** 以 Unicode 码点计数（String.length 计 UTF-16 代码单元，会把 emoji 记为 2）。 */
function codePointLength(value: string): number {
  return [...value].length;
}

/** 仅接受 JSON 可表达的普通对象（拒绝数组、null、类实例），防“任意对象冒充契约”。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requirePlainObject(
  value: unknown,
  context: ValidationContext,
  field: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw validationError(context, field, '必须是 JSON 对象', value);
  }
  return value;
}

const FORBIDDEN_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 拒绝白名单之外的键：有版本契约的结构不接受未知格式字段。 */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: ValidationContext,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw validationError(context, field, `包含未知字段 ${key}（schemaVersion 限定的结构不接受任意对象）`);
    }
  }
}

/** 开放 Record（如 agentOverrides）的键名守卫：拒绝空键与原型污染键。 */
export function requireSafeRecordKey(key: string, context: ValidationContext, field: string): void {
  if (key.trim().length === 0) {
    throw validationError(context, field, '记录键不允许为空');
  }
  if (FORBIDDEN_RECORD_KEYS.has(key)) {
    throw validationError(context, field, `记录键 ${key} 不被允许（原型污染防护）`);
  }
}

export function requireNonEmptyString(
  value: unknown,
  context: ValidationContext,
  field: string,
): string {
  if (typeof value !== 'string') {
    throw validationError(context, field, '必须是字符串', value);
  }
  if (value.trim().length === 0) {
    throw validationError(context, field, '不允许为空或全空白');
  }
  return value;
}

/** 可选且可空字符串：undefined 保持缺席，null 显式置空，字符串须非空白。 */
export function optionalNullableString(
  value: unknown,
  context: ValidationContext,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return requireNonEmptyString(value, context, field);
}

/**
 * 稳定 ID：应用侧生成（设计 03 建议 UUID），数据库保存 TEXT。
 * 字符集受限，保证后续可安全用于受控路径推导（F-010）。
 */
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateStableId(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value)) {
    throw validationError(
      context,
      field,
      '必须是 1-128 位、以字母数字开头且仅含 [A-Za-z0-9._-] 的稳定 ID',
      value,
    );
  }
  return value;
}

/** SHA-256 摘要：64 位小写十六进制。非法摘要一律是校验错误。 */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function validateSha256Digest(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
    throw validationError(context, field, '必须是 64 位小写十六进制 SHA-256 摘要', value);
  }
  return value;
}

/** CAS 期望修订号：≥1 的整数；0、负数、小数、字符串数字均拒绝。 */
export function validateExpectedRevision(value: unknown, context: ValidationContext): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw validationError(context, 'expectedRevision', '必须是 ≥1 的整数（CAS 期望修订号）', value);
  }
  return value;
}

export function validatePositiveInteger(value: unknown, context: ValidationContext, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw validationError(context, field, '必须是 ≥1 的整数', value);
  }
  return value;
}

export function validateNonNegativeInteger(
  value: unknown,
  context: ValidationContext,
  field: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw validationError(context, field, '必须是 ≥0 的整数', value);
  }
  return value;
}

/**
 * 项目展示名校验（注册/编辑共用）：必须是非空字符串，去除首尾空白后长度不超过
 * `PROJECT_DISPLAY_NAME_MAX_LENGTH`。展示名不参与身份或物理路径（见 §3 复用规则）。
 */
export function validateProjectDisplayName(
  value: unknown,
  context: ValidationContext,
  field = 'displayName',
): string {
  if (typeof value !== 'string') {
    throw validationError(context, field, '必须是字符串', value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw validationError(context, field, '不允许为空或全空白');
  }
  if (codePointLength(trimmed) > PROJECT_DISPLAY_NAME_MAX_LENGTH) {
    throw validationError(
      context,
      field,
      `长度不得超过 ${PROJECT_DISPLAY_NAME_MAX_LENGTH} 个字符（Unicode 码点）`,
      value,
    );
  }
  return trimmed;
}

/**
 * 项目说明校验（注册/编辑共用）：
 * - 省略（undefined）表示“未提供”，由调用方决定默认值；
 * - null、空字符串或全空白统一规范化为 null（空描述是合法输入，见 PRD）；
 * - 其余字符串按原样保留（Markdown/Unicode/换行不转写），长度不超过 `DESCRIPTION_MAX_LENGTH`。
 */
export function validateProjectDescription(
  value: unknown,
  context: ValidationContext,
  field = 'description',
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw validationError(context, field, '必须是字符串、null 或省略', value);
  }
  if (value.trim().length === 0) {
    return null;
  }
  if (codePointLength(value) > DESCRIPTION_MAX_LENGTH) {
    throw validationError(
      context,
      field,
      `长度不得超过 ${DESCRIPTION_MAX_LENGTH} 个字符（Unicode 码点）`,
      value,
    );
  }
  return value;
}

/**
 * 项目/实体标签规范化（设计 11 §10）：默认空数组；元素须为非空白字符串；
 * trim → Unicode NFC → ASCII 小写（仅 A-Z，不影响其他文字）；同一实体内去重；
 * 单个标签长度不超过 `LABEL_MAX_LENGTH`，去重后数量不超过 `LABELS_MAX_COUNT`。
 *
 * 注册、元数据编辑与查询筛选必须共用本函数（唯一标签规则），标签只作为不透明
 * 检索元数据，不解释为模型、权限、状态或子级继承政策。
 */
export function normalizeLabels(value: unknown, context: ValidationContext, field = 'labels'): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw validationError(context, field, '必须是字符串数组', value);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const itemField = `${field}[${index}]`;
    if (typeof item !== 'string') {
      throw validationError(context, itemField, '标签必须是字符串', item);
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      throw validationError(context, itemField, '标签不允许为空或全空白');
    }
    const normalized = trimmed.normalize('NFC').replaceAll(/[A-Z]/g, (char) => char.toLowerCase());
    if (codePointLength(normalized) > LABEL_MAX_LENGTH) {
      throw validationError(
        context,
        itemField,
        `标签长度不得超过 ${LABEL_MAX_LENGTH} 个字符（Unicode 码点）`,
      );
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  if (result.length > LABELS_MAX_COUNT) {
    throw validationError(
      context,
      field,
      `标签数量不得超过 ${LABELS_MAX_COUNT} 个（去重后）`,
    );
  }
  return result;
}

/**
 * 受控逻辑 locator：仅为逻辑相对位置（POSIX 分隔），绝不接受任意用户绝对路径。
 * 物理路径只能由授权数据根 + 稳定 ID 推导（F-010），locator 本身不构成文件系统授权。
 */
export function validateArtifactLocator(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(context, field, '必须是非空的受控逻辑相对位置', value);
  }
  if (value.includes('\0')) {
    throw validationError(context, field, '不允许包含 NUL 字节');
  }
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value) || value.includes('\\')) {
    throw validationError(context, field, '必须是 POSIX 相对逻辑位置，不接受绝对路径或反斜杠');
  }
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw validationError(context, field, '不允许空段、. 或 .. 段（防目录穿越）');
    }
  }
  return value;
}
