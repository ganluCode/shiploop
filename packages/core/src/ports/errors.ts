/**
 * F-002 结构化存储错误（ports 契约层）。
 *
 * 设计依据：core-design/03 §3（busy 冲突有限退避后返回结构化错误）、
 * §6（不支持的高版本拒绝写入）与 core-design/11 §1（CAS revision）。
 *
 * 约定：
 * - 每个错误都携带 kind、operation（发生操作）与适用的实体身份（entity），
 *   供 Host/CLI 做结构化呈现与重试决策，不依赖错误文案匹配；
 * - details 只放可序列化、已脱敏的诊断字段（如 field/reason/expectedRevision），
 *   绝不放凭据、payload 原文或完整用户路径；
 * - TypeScript 类型只是编译期提示：跨越端口边界的外部 JSON 必须经
 *   ports/validation.ts 的运行时校验，校验失败抛 kind='validation' 的本错误。
 */
export type StorageEntityType =
  | 'project'
  | 'global_settings'
  | 'project_settings'
  | 'artifact'
  | 'migration';

export type StorageErrorKind =
  /** 外部输入未通过运行时校验（缺字段/类型错误/未知 schemaVersion/非法摘要等）。 */
  | 'validation'
  /** 请求的实体不存在。 */
  | 'not_found'
  /** CAS revision 冲突、唯一性冲突或状态前置条件不满足（如终态不可覆盖）。 */
  | 'conflict'
  /** 有界 busy 等待/重试预算耗尽（F-004 起由适配器产生）。 */
  | 'busy'
  /** 持久化数据损坏：非法 JSON、未知格式、正文缺失或摘要/大小不匹配。 */
  | 'corrupt'
  /** 库或数据的版本高于本版本支持范围，拒绝写入（F-005 起由适配器产生）。 */
  | 'unsupported_version'
  /** 跨项目归属违规：请求实体存在但不属于给定 projectId。 */
  | 'ownership';

/** 适用实体身份：错误归属于哪类实体、哪个实例、哪个项目。 */
export interface StorageEntityRef {
  readonly type: StorageEntityType;
  readonly id?: string;
  readonly projectId?: string;
}

export interface StorageErrorOptions {
  readonly entity?: StorageEntityRef;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  readonly operation: string;
  readonly entity: StorageEntityRef | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: StorageErrorKind,
    operation: string,
    message: string,
    options: StorageErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'StorageError';
    this.kind = kind;
    this.operation = operation;
    this.entity = options.entity;
    this.details = options.details;
  }
}

/** 类型守卫；kind 传入时同时按错误类别收窄。 */
export function isStorageError(value: unknown, kind?: StorageErrorKind): value is StorageError {
  return value instanceof StorageError && (kind === undefined || value.kind === kind);
}
