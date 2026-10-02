/**
 * F-010 制品文件窄契约（ports 契约层）：受控逻辑定位、同文件系统 staging 与
 * 路径安全的表达形态。
 *
 * 设计依据：core-design/03 §4（pending 登记 → 同文件系统 staging → 校验 →
 * ready；路径通过 ID 和授权根计算，检查 realpath、符号链接、目录穿越；不拼接
 * 不可信标题）与 core-design/11 §8（storage_locator 为受控逻辑定位，不接收任意
 * 用户路径）。
 *
 * 契约要点：
 * - 物理位置只由授权数据根 + 稳定 project/artifact ID 推导：
 *     正式  <数据根>/projects/<projectId>/artifacts/<artifactId>/content
 *     暂存  <数据根>/staging/<projectId>/<artifactId>.<随机>.part
 *   locator 是制品索引中的逻辑身份字段，参与校验与诊断，绝不参与物理路径推导；
 *   中文标题、displayName、description、kind 均不是本契约的输入，不能控制物理路径；
 * - staging 与正式文件结构性地位于同一文件系统（同在授权数据根之下）；发布采用
 *   不覆盖策略（hard link + 移除 staging），已存在的同名目标保留并返回冲突；
 * - 目录扫描不跟随符号链接，迭代/分页限制每批处理量；
 * - 输入校验失败抛 StorageError(kind='validation')（与 F-002 一致）；文件系统
 *   运行期失败抛 ArtifactFileError（escape/conflict/not_found/not_regular_file/
 *   permission/io），消息与 details 只含相对逻辑位置与错误码，不含绝对路径或
 *   正文内容；
 * - 可信项目模式边界：检查（realpath/lstat/no-follow）与文件操作之间的并发替换
 *   窗口由“单 Host 写入者 + 用户明确授权的可信项目”前提收窄，本契约不宣称强
 *   OS 沙箱；发布不覆盖这一关键步骤由 link 的 EEXIST 语义保证，无检查-操作窗口。
 * - 本层为纯契约：类型、常量、纯推导与纯校验函数，无任何 I/O；真实文件系统
 *   适配器在 adapters 层实现（F-010），供后续统一 PathService 复用；仓库接入
 *   不属于本契约。
 */
import type { Readable, Writable } from 'node:stream';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateArtifactLocator,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/** 制品文件键：物理位置仅由 projectId/artifactId 推导。 */
export interface ArtifactFileKey {
  readonly projectId: string;
  readonly artifactId: string;
  /**
   * 制品索引中的逻辑 locator（可选携带以便诊断对齐）；经 F-002 locator 校验，
   * 绝不参与物理路径推导。
   */
  readonly locator?: string;
}

export function validateArtifactFileKey(value: unknown, operation: string): ArtifactFileKey {
  const context: ValidationContext = { operation, entity: { type: 'artifact' } };
  const object = requirePlainObject(value, context, 'key');
  rejectUnknownKeys(object, ['projectId', 'artifactId', 'locator'], context, 'key');
  const key: ArtifactFileKey = {
    projectId: validateStableId(object.projectId, context, 'key.projectId'),
    artifactId: validateStableId(object.artifactId, context, 'key.artifactId'),
    ...(object.locator !== undefined
      ? { locator: validateArtifactLocator(object.locator, context, 'key.locator') }
      : {}),
  };
  return key;
}

/** 正式文件的固定叶名：内容身份不可变，单制品单正文文件，叶名不含任何用户输入。 */
export const ARTIFACT_FILE_CONTENT_LEAF = 'content';

/** 项目的正式制品区相对目录（受控根内，POSIX 分隔）。 */
export function deriveProjectArtifactsRelativeDir(projectId: string): string {
  return `projects/${projectId}/artifacts`;
}

/** 单制品的正式目录（受控根内，POSIX 分隔）。 */
export function deriveArtifactFinalRelativeDir(key: ArtifactFileKey): string {
  return `${deriveProjectArtifactsRelativeDir(key.projectId)}/${key.artifactId}`;
}

/** 单制品的正式文件相对位置（受控根内，POSIX 分隔）。 */
export function deriveArtifactFinalRelativePath(key: ArtifactFileKey): string {
  return `${deriveArtifactFinalRelativeDir(key)}/${ARTIFACT_FILE_CONTENT_LEAF}`;
}

/** 项目的 staging 区相对目录（受控根内，POSIX 分隔）。 */
export function deriveStagingRelativeDir(projectId: string): string {
  return `staging/${projectId}`;
}

/** staging 文件名后缀；发布前/中断恢复核对以此识别未完成的暂存正文。 */
export const ARTIFACT_STAGING_FILE_SUFFIX = '.part';

/**
 * 制品文件运行期错误类别。输入校验失败仍使用 StorageError(kind='validation')；
 * 本类别只覆盖文件系统运行期条件。
 */
export type ArtifactFileErrorKind =
  /** 适配器装配参数或句柄形态非法（如相对数据根、伪造的 staging 引用）。 */
  | 'invalid_input'
  /** 路径逃逸或不可信符号链接（祖先 realpath 越出授权根、目标为链接等）。 */
  | 'escape'
  /** 目标已存在；不覆盖策略下保留既有内容并返回冲突。 */
  | 'conflict'
  /** 数据根/文件不存在。 */
  | 'not_found'
  /** 目标存在但不是常规文件（目录、设备等）。 */
  | 'not_regular_file'
  /** 权限拒绝（EACCES/EPERM）。 */
  | 'permission'
  /** 其他 I/O 失败（details 携带脱敏 code，如 ENOSPC/EXDEV）。 */
  | 'io';

export interface ArtifactFileErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * 制品文件运行期错误。消息与 details 只允许出现受控根内的相对逻辑位置与
 * 脱敏错误码，绝不包含绝对路径或正文内容（与 F-002 错误的脱敏约定一致）。
 */
export class ArtifactFileError extends Error {
  readonly kind: ArtifactFileErrorKind;
  readonly operation: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: ArtifactFileErrorKind,
    operation: string,
    message: string,
    options: ArtifactFileErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ArtifactFileError';
    this.kind = kind;
    this.operation = operation;
    this.details = options.details;
  }
}

export function isArtifactFileError(
  value: unknown,
  kind?: ArtifactFileErrorKind,
): value is ArtifactFileError {
  return value instanceof ArtifactFileError && (kind === undefined || value.kind === kind);
}

/** 受控定位结果：相对位置仅作诊断/核对展示，不构成文件系统授权。 */
export interface ArtifactFilePlacement {
  readonly projectId: string;
  readonly artifactId: string;
  /** 正式文件相对位置（POSIX 分隔）。 */
  readonly finalRelativePath: string;
  /** staging 区相对目录（实际 staging 文件名另含防碰撞随机成分）。 */
  readonly stagingRelativeDir: string;
}

/** 已打开的 staging 写入：O_EXCL + 受限权限；调用方写入并 end() 后必须 finish 或 discard。 */
export interface ArtifactStagingWrite {
  /** staging 区内相对位置（staging/<projectId>/<artifactId>.<随机>.part）。 */
  readonly relativePath: string;
  readonly stream: Writable;
}

/** 已完成写入并 fsync 的 staging 文件，可发布或丢弃。 */
export interface ArtifactStagingFile {
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface ArtifactPublishedFile {
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface ArtifactFileContent {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly stream: Readable;
}

export interface ArtifactFileStat {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export type ArtifactFileEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface ArtifactFileScanEntry {
  /** 目录条目名（不提供完整路径之外的任何信任假设）。 */
  readonly name: string;
  /** 受控根内相对位置（POSIX 分隔）。 */
  readonly relativePath: string;
  readonly kind: ArtifactFileEntryKind;
  /** 仅常规文件携带字节数；符号链接等一律 null（不跟随、不穿透）。 */
  readonly sizeBytes: number | null;
}

export interface ArtifactFileScanPage {
  readonly entries: readonly ArtifactFileScanEntry[];
  /** 还有更多条目时为下一页游标（本页最后一个条目名），否则 null。 */
  readonly nextCursor: string | null;
}

export interface ArtifactFileScanOptions {
  /** 每批最大条目数（1..ARTIFACT_FILE_SCAN_MAX_LIMIT）。 */
  readonly limit?: number;
  /** 上一页返回的 nextCursor。 */
  readonly cursor?: string;
}

export const ARTIFACT_FILE_SCAN_DEFAULT_LIMIT = 64;
export const ARTIFACT_FILE_SCAN_MAX_LIMIT = 256;

export function validateArtifactFileScanOptions(
  value: unknown,
  operation: string,
): { limit: number; cursor?: string } {
  const context: ValidationContext = { operation };
  if (value === undefined) {
    return { limit: ARTIFACT_FILE_SCAN_DEFAULT_LIMIT };
  }
  const object = requirePlainObject(value, context, 'options');
  rejectUnknownKeys(object, ['limit', 'cursor'], context, 'options');
  let limit = ARTIFACT_FILE_SCAN_DEFAULT_LIMIT;
  if (object.limit !== undefined) {
    if (
      typeof object.limit !== 'number' ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > ARTIFACT_FILE_SCAN_MAX_LIMIT
    ) {
      throw validationError(
        context,
        'options.limit',
        `必须是 1..${ARTIFACT_FILE_SCAN_MAX_LIMIT} 的整数（每批处理量上限）`,
        object.limit,
      );
    }
    limit = object.limit;
  }
  if (object.cursor !== undefined) {
    if (
      typeof object.cursor !== 'string' ||
      object.cursor.length === 0 ||
      object.cursor.includes('/') ||
      object.cursor.includes('\0')
    ) {
      throw validationError(context, 'options.cursor', '必须是上一页返回的条目名游标', object.cursor);
    }
    return { limit, cursor: object.cursor };
  }
  return { limit };
}

/**
 * 最小制品文件端口：受控定位、staging 生命周期、不覆盖发布、读取/核对入口与
 * 有界扫描。实现者：F-010 的文件系统适配器；供后续统一 PathService 复用。
 *
 * 时序约定（与 core-design/03 §4 一致）：先登记 pending 索引（F-009），再经
 * openStagingWrite → finishStaging → publishStaging 落盘正文，最后短事务标
 * ready；文件流、fsync 与发布均不在数据库事务内（F-011 组合）。
 */
export interface ArtifactFileStore {
  /** 纯定位推导：校验键并返回受控相对位置；不产生任何 I/O 副作用。 */
  resolvePlacement(key: unknown): ArtifactFilePlacement;
  /** 打开 staging 写入（O_EXCL、受限权限、祖先 realpath 核验）。 */
  openStagingWrite(key: unknown): Promise<ArtifactStagingWrite>;
  /** 等待流完成、fsync 并关闭 staging 文件；失败时保留残留供核对，不自动删除。 */
  finishStaging(write: ArtifactStagingWrite): Promise<ArtifactStagingFile>;
  /** 发布：staging → 正式位置（同文件系统、不覆盖、目录同步）；目标已存在返回冲突并保留。 */
  publishStaging(staging: ArtifactStagingFile, key: unknown): Promise<ArtifactPublishedFile>;
  /** 丢弃 staging 残留（仅限受控 staging 区内的常规文件）；幂等。 */
  discardStaging(staging: ArtifactStagingWrite | ArtifactStagingFile): Promise<void>;
  /** 读取入口：no-follow 打开并核验常规文件；逃逸/缺失/非常规文件明确报错。 */
  openFinalRead(key: unknown): Promise<ArtifactFileContent>;
  /** 核对入口：lstat 元数据（不读取正文、不跟随链接）。 */
  statFinal(key: unknown): Promise<ArtifactFileStat>;
  /** 扫描项目正式制品区：不跟随链接、每批限量；项目尚无制品区时返回空页。 */
  scanFinalArea(projectId: string, options?: unknown): Promise<ArtifactFileScanPage>;
  /** 扫描项目 staging 区：不跟随链接、每批限量；区不存在时返回空页。 */
  scanStagingArea(projectId: string, options?: unknown): Promise<ArtifactFileScanPage>;
}
