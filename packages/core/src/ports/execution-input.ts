/**
 * P03-2 / F-004 执行必需输入窄契约（ports 契约层：类型、常量、纯校验函数与
 * 受控源文件读取端口形态，无任何 I/O）。
 *
 * 设计依据：core-design/06 §"Attempt 输入固定"（Attempt 固定输入引用和摘要，
 * 缺失必需输入明确失败，不能把可变化路径当作快照）、core-design/13 §2
 * （InputManifest 记录选取与读取证据，缺失必需输入应明确失败）与
 * core-design/03 §4（路径通过 ID 和授权根计算，检查 realpath、符号链接、
 * 目录穿越）。
 *
 * 契约要点：
 * - 输入引用（ExecutionInputRef）是内容身份摘要，不是正文本身：projectId、
 *   Artifact 身份、版本、hash、大小、受控逻辑 locator 与用途；正文永不进入
 *   引用、配置、prompt 或错误字段；
 * - 可变文件来源只表达为「获准根 ID + POSIX 相对路径」（InputSourceFileSource），
 *   源文件绝对路径不是快照、不进入引用与错误；采集时捕获实际字节并经
 *   ArtifactPublisher 发布为同项目不可变受管 Artifact（application 层职责）；
 * - 已有受管引用来源（artifact）按 artifactId 归一解析，项目归属与 ready 状态
 *   由 ArtifactStore 核验（跨项目 ownership、pending/failed 不可用）；
 * - 秘密纪律：输入项不允许内联正文/凭据字段（rejectUnknownKeys fail-closed），
 *   凭据只以引用表达，本契约不解析任何认证材料；
 * - 受控源文件读取端口（InputSourceFileReader）只承诺路径安全形态：获准根
 *   白名单、realpath  containment、lstat/no-follow、常规文件核验；物理位置
 *   推导与文件打开由 adapters 层实现；
 * - 输入校验失败抛 StorageError(kind='validation')（与既有契约一致）；源文件
 *   运行期条件抛 InputSourceError（invalid_input/unknown_root/not_found/escape/
 *   not_regular_file/permission/io），消息与 details 只含相对逻辑位置与脱敏
 *   错误码，不含绝对路径或正文内容；
 * - 可信项目模式 ≠ 强 OS 沙箱：检查与操作之间的并发替换窗口由「单 Host
 *   写入者 + 用户明确授权的可信项目」前提收窄，本契约不宣称强隔离。
 *
 * 实现者：adapters/fs/input-source-files.ts（真实文件系统读取适配器）与
 * application/execution-input.ts（采集与校验读取出排）；本层不实现任何存储
 * 或文件系统行为。
 */
import type { Readable } from 'node:stream';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateArtifactLocator,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/** 采集发布到制品索引的固定 kind（执行必需输入）。 */
export const EXECUTION_INPUT_ARTIFACT_KIND = 'execution-input';

/** 采集制品的受控逻辑 locator 前缀（POSIX 相对；实际 locator = <前缀>/<用途>）。 */
export const EXECUTION_INPUT_LOCATOR_PREFIX = 'execution-inputs';

/** 文件来源缺省 mediaType（未知二进制，不猜测内容类型）。 */
export const EXECUTION_INPUT_DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/** 用途的最大长度（字符）：引用与 locator 的有界成分。 */
export const EXECUTION_INPUT_PURPOSE_MAX_LENGTH = 128;

/** 必需输入来源类别：已有受管制品引用，或获准根内的可变文件。 */
export type ExecutionInputSourceKind = 'artifact' | 'file';

/** 已有受管制品引用来源：仅携带制品身份，项目归属由采集请求绑定。 */
export interface ExecutionInputArtifactSource {
  readonly kind: 'artifact';
  readonly artifactId: string;
}

/** 可变文件来源：获准根 ID + POSIX 相对路径；绝对路径一律拒绝（不是快照）。 */
export interface ExecutionInputFileSource {
  readonly kind: 'file';
  /** 装配期注入的获准根 ID（白名单键），不是路径本身。 */
  readonly root: string;
  /** 获准根内 POSIX 相对位置（不接受绝对路径/.. 段/反斜杠）。 */
  readonly relativePath: string;
  /** 可选媒体类型；缺席按 application/octet-stream。 */
  readonly mediaType?: string;
}

export type ExecutionInputSource = ExecutionInputArtifactSource | ExecutionInputFileSource;

/** 必需输入项：用途 + 来源。所有项都是必需的——缺失/不可用即明确失败。 */
export interface ExecutionInputItem {
  readonly purpose: string;
  readonly source: ExecutionInputSource;
}

/**
 * 用途校验：非空、有界（≤128 字符）、不含路径分隔/NUL 且不是 . 或 ..
 * （purpose 参与受控 locator 推导，结构安全先行）。
 */
export function validateExecutionInputPurpose(
  value: unknown,
  context: ValidationContext,
  field: string,
): string {
  const purpose = requireNonEmptyString(value, context, field);
  if (purpose.length > EXECUTION_INPUT_PURPOSE_MAX_LENGTH) {
    throw validationError(
      context,
      field,
      `长度不能超过 ${EXECUTION_INPUT_PURPOSE_MAX_LENGTH} 字符`,
      purpose.length,
    );
  }
  if (
    purpose.includes('\0') ||
    purpose.includes('/') ||
    purpose.includes('\\') ||
    purpose === '.' ||
    purpose === '..'
  ) {
    throw validationError(context, field, '不允许包含路径分隔符、NUL 或 . 或 ..（用途参与受控 locator 推导）');
  }
  return purpose;
}

/** 来源校验：白名单类别；未知类别与多余字段（含内联正文/凭据字段）一律拒绝。 */
export function validateExecutionInputSource(
  value: unknown,
  operation: string,
): ExecutionInputSource {
  const context: ValidationContext = { operation, entity: { type: 'artifact' } };
  const object = requirePlainObject(value, context, 'source');
  if (object.kind === 'artifact') {
    rejectUnknownKeys(object, ['kind', 'artifactId'], context, 'source');
    return {
      kind: 'artifact',
      artifactId: validateStableId(object.artifactId, context, 'source.artifactId'),
    };
  }
  if (object.kind === 'file') {
    rejectUnknownKeys(object, ['kind', 'root', 'relativePath', 'mediaType'], context, 'source');
    return {
      kind: 'file',
      root: validateStableId(object.root, context, 'source.root'),
      relativePath: validateArtifactLocator(object.relativePath, context, 'source.relativePath'),
      ...(object.mediaType !== undefined
        ? { mediaType: requireNonEmptyString(object.mediaType, context, 'source.mediaType') }
        : {}),
    };
  }
  throw validationError(
    context,
    'source.kind',
    '必须是 artifact 或 file（未知来源类别 fail-closed，不猜测语义）',
    object.kind,
  );
}

/** 输入项校验：用途 + 来源；多余字段（含 content/secret 等内联字段）一律拒绝。 */
export function validateExecutionInputItem(value: unknown, operation: string): ExecutionInputItem {
  const context: ValidationContext = { operation, entity: { type: 'artifact' } };
  const object = requirePlainObject(value, context, 'item');
  rejectUnknownKeys(object, ['purpose', 'source'], context, 'item');
  return {
    purpose: validateExecutionInputPurpose(object.purpose, context, 'item.purpose'),
    source: validateExecutionInputSource(object.source, operation),
  };
}

/** 引用来源记录：文件来源只保留逻辑身份（获准根 ID + 相对路径），不是绝对路径。 */
export type ExecutionInputOrigin =
  | { readonly kind: 'artifact' }
  | { readonly kind: 'file'; readonly root: string; readonly relativePath: string };

/**
 * 执行必需输入引用：同项目不可变正文的内容身份摘要（不是正文本身）。
 * 核验读取以权威索引为准，引用字段只作一致性核对——被修补的引用明确失败。
 */
export interface ExecutionInputRef {
  readonly projectId: string;
  readonly artifactId: string;
  readonly kind: string;
  readonly purpose: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly mediaType: string;
  readonly origin: ExecutionInputOrigin;
}

/** 引用形态校验（读取入口边界）：严格字段集，非法摘要/版本/未知键一律拒绝。 */
export function validateExecutionInputRef(value: unknown, operation: string): ExecutionInputRef {
  const context: ValidationContext = { operation, entity: { type: 'artifact' } };
  const object = requirePlainObject(value, context, 'ref');
  rejectUnknownKeys(
    object,
    ['projectId', 'artifactId', 'kind', 'purpose', 'version', 'contentHash', 'sizeBytes', 'locator', 'mediaType', 'origin'],
    context,
    'ref',
  );
  const originValue = requirePlainObject(object.origin, context, 'ref.origin');
  let origin: ExecutionInputOrigin;
  if (originValue.kind === 'artifact') {
    rejectUnknownKeys(originValue, ['kind'], context, 'ref.origin');
    origin = { kind: 'artifact' };
  } else if (originValue.kind === 'file') {
    rejectUnknownKeys(originValue, ['kind', 'root', 'relativePath'], context, 'ref.origin');
    origin = {
      kind: 'file',
      root: validateStableId(originValue.root, context, 'ref.origin.root'),
      relativePath: validateArtifactLocator(originValue.relativePath, context, 'ref.origin.relativePath'),
    };
  } else {
    throw validationError(context, 'ref.origin.kind', '必须是 artifact 或 file', originValue.kind);
  }
  return {
    projectId: validateStableId(object.projectId, context, 'ref.projectId'),
    artifactId: validateStableId(object.artifactId, context, 'ref.artifactId'),
    kind: requireNonEmptyString(object.kind, context, 'ref.kind'),
    purpose: validateExecutionInputPurpose(object.purpose, context, 'ref.purpose'),
    version: validatePositiveInteger(object.version, context, 'ref.version'),
    contentHash: validateSha256Digest(object.contentHash, context, 'ref.contentHash'),
    sizeBytes: validateNonNegativeInteger(object.sizeBytes, context, 'ref.sizeBytes'),
    locator: validateArtifactLocator(object.locator, context, 'ref.locator'),
    mediaType: requireNonEmptyString(object.mediaType, context, 'ref.mediaType'),
    origin,
  };
}

/** 受控源文件读取请求：获准根 ID + POSIX 相对路径。 */
export interface InputSourceReadRequest {
  readonly root: string;
  readonly relativePath: string;
}

export function validateInputSourceReadRequest(
  value: unknown,
  operation: string,
): InputSourceReadRequest {
  const context: ValidationContext = { operation };
  const object = requirePlainObject(value, context, 'request');
  rejectUnknownKeys(object, ['root', 'relativePath'], context, 'request');
  return {
    root: validateStableId(object.root, context, 'request.root'),
    relativePath: validateArtifactLocator(object.relativePath, context, 'request.relativePath'),
  };
}

/** 已打开的源文件读取：字节数来自 fstat（采集方仍逐块实测核验）。 */
export interface InputSourceContent {
  /** 获准根内 POSIX 相对位置（诊断用，不含绝对路径）。 */
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly stream: Readable;
}

/** 源文件读取运行期错误类别；输入校验失败使用 StorageError(kind='validation')。 */
export type InputSourceErrorKind =
  /** 装配参数非法（相对根、缺失根、非目录根、非法根 ID）。 */
  | 'invalid_input'
  /** 根 ID 不在装配期获准白名单内。 */
  | 'unknown_root'
  /** 目标不存在。 */
  | 'not_found'
  /** 路径逃逸或不可信符号链接（叶为链接、祖先 realpath 越出获准根）。 */
  | 'escape'
  /** 目标存在但不是常规文件（目录、设备等）。 */
  | 'not_regular_file'
  /** 权限拒绝（EACCES/EPERM）。 */
  | 'permission'
  /** 其他 I/O 失败（details 携带脱敏 code）。 */
  | 'io';

export interface InputSourceErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * 源文件读取运行期错误。消息与 details 只允许出现获准根内相对位置与脱敏
 * 错误码，绝不包含绝对路径或正文内容（与 ArtifactFileError 脱敏约定一致）。
 */
export class InputSourceError extends Error {
  readonly kind: InputSourceErrorKind;
  readonly operation: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: InputSourceErrorKind,
    operation: string,
    message: string,
    options: InputSourceErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'InputSourceError';
    this.kind = kind;
    this.operation = operation;
    this.details = options.details;
  }
}

export function isInputSourceError(
  value: unknown,
  kind?: InputSourceErrorKind,
): value is InputSourceError {
  return value instanceof InputSourceError && (kind === undefined || value.kind === kind);
}

/**
 * 受控源文件读取窄端口：获准根白名单内的 no-follow 常规文件读取。
 * 实现者：adapters/fs/input-source-files.ts；路径安全（realpath containment、
 * lstat/no-follow、O_NOFOLLOW 打开 + fstat 复核）由实现方承担，本端口不拼接
 * 任何路径。不承诺强 OS 沙箱（可信项目模式，见文件头说明）。
 */
export interface InputSourceFileReader {
  /** 打开获准根内常规文件读取；逃逸/缺失/非常规文件/未知根明确报错。 */
  openSourceRead(request: unknown): Promise<InputSourceContent>;
}
