/**
 * P01-3 / F-003 统一 PathService 窄契约（ports 契约层：类型、常量、纯推导与
 * 纯校验函数，无任何 I/O）。
 *
 * 设计依据：core-design/01 §4（数据根通过 PathService 按操作系统解析稳定
 * namespace，不随展示品牌变化）、core-design/03 §4（数据根布局：core.sqlite、
 * projects/<id>/、staging/；路径通过 ID 和授权根计算，检查 realpath、符号链接、
 * 目录穿越，不拼接不可信标题）与 docs/p01-3-application-contract.md §4.3。
 *
 * 契约要点：
 * - 稳定技术 dataNamespace = "shiploop"：产品展示名/桌面品牌变化不改变数据目录；
 *   displayName、description、标签、标题均不参与任何物理路径推导；
 * - 默认根（macOS）：<注入的用户目录>/Library/Application Support/shiploop。
 *   用户目录由装配方显式注入（deriveDefaultDataRoot 是纯推导）；本契约不读取
 *   真实用户目录，测试以临时 home/dataRoot 注入；
 * - 物理位置只由「已 realpath 的授权数据根 + 稳定 projectId/artifactId」推导；
 *   数据库（core.sqlite）与项目制品共用同一数据根，与源仓库分离；
 * - 只支持当前已实现的资源类型（PROJECT_RESOURCE_TYPES）；Run/Session/Worktree
 *   等尚未实现的类型一律拒绝，不提前创建其目录形态；
 * - 受权定位（locateProjectResource）先核验「项目真实存在且资源归属调用绑定的
 *   项目范围」，再返回范围内位置：项目存在性由装配注入的 ProjectExistenceLookup
 *   （StateStore.getProject 结构子集）核验，不能仅凭传入 projectId 授权；
 *   跨项目归属违规抛 StorageError(kind='ownership')，未知项目 not_found；
 * - 输入校验失败抛 StorageError(kind='validation')（复用 F-002 校验器）；文件系统
 *   运行期条件（根不存在/逃逸/权限）抛 PathResolutionError，消息与 details 只含
 *   受控根内相对位置与脱敏错误码，不含绝对路径；
 * - 可信项目模式 ≠ 强 OS 沙箱：检查与操作之间的并发替换窗口由「单 Host 写入者 +
 *   用户明确授权」前提收窄，本契约不宣称强隔离。
 *
 * 实现者：adapters/fs/path-service.ts（F-003）；组合根（F-012）负责把
 * StateStore/ArtifactStore 装配到同一数据根。
 */
import {
  deriveArtifactFinalRelativePath,
  deriveProjectArtifactsRelativeDir,
  deriveStagingRelativeDir,
} from './artifact-files.js';
import type { StateStore } from './state-store.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/**
 * 稳定技术数据 namespace（设计 01 §4：发布前定案，此后稳定；展示品牌变更不触发
 * 数据目录迁移）。P01-3 实施契约值，见 docs/p01-3-application-contract.md §9-3。
 */
export const DATA_NAMESPACE = 'shiploop';

/** macOS 默认数据根在注入用户目录内的相对位置（POSIX 分隔）。 */
export const MACOS_APPLICATION_SUPPORT_RELATIVE_DIR = 'Library/Application Support';

/** 状态库文件名（设计 03 §4 数据根布局：core.sqlite）。 */
export const DATABASE_FILE_NAME = 'core.sqlite';

/** 数据根内的项目区相对根（POSIX 分隔）。 */
export const PROJECTS_RELATIVE_ROOT = 'projects';

/**
 * 默认数据根纯推导：<userHomeDir>/Library/Application Support/shiploop。
 *
 * 只做字符串推导与输入校验，不接触文件系统；userHomeDir 由装配方显式注入
 * （生产装配注入 os.homedir()，测试注入临时目录），本函数不读取真实用户目录。
 * 输入非法抛 StorageError(kind='validation')。
 */
export function deriveDefaultDataRoot(
  userHomeDir: unknown,
  operation = 'PathService.deriveDefaultDataRoot',
): string {
  const context: ValidationContext = { operation };
  if (typeof userHomeDir !== 'string' || userHomeDir.length === 0) {
    throw validationError(context, 'userHomeDir', '必须是非空字符串（注入的 macOS 用户目录）', userHomeDir);
  }
  if (userHomeDir.includes('\0')) {
    throw validationError(context, 'userHomeDir', '不允许包含 NUL 字节');
  }
  if (!userHomeDir.startsWith('/')) {
    throw validationError(context, 'userHomeDir', '必须是 POSIX 绝对路径（macOS 注入用户目录）', userHomeDir);
  }
  const trimmed = userHomeDir.replaceAll(/\/+$/g, '');
  if (trimmed.length === 0) {
    throw validationError(context, 'userHomeDir', '不允许是文件系统根（拒绝把整盘当数据根）');
  }
  return `${trimmed}/${MACOS_APPLICATION_SUPPORT_RELATIVE_DIR}/${DATA_NAMESPACE}`;
}

/** 数据库文件在数据根内的相对位置（POSIX 分隔）。 */
export function deriveDatabaseRelativePath(): string {
  return DATABASE_FILE_NAME;
}

/** 项目目录在数据根内的相对位置（POSIX 分隔）；调用前 projectId 须已过 validateStableId。 */
export function deriveProjectRelativeDir(projectId: string): string {
  return `${PROJECTS_RELATIVE_ROOT}/${projectId}`;
}

/**
 * 当前已实现的受控资源类型（白名单）。Run/Session/Worktree/documents 等目录形态
 * 尚未实现，一律拒绝，不提前创建。
 */
export const PROJECT_RESOURCE_TYPES = [
  /** 项目目录：<root>/projects/<projectId>。 */
  'project_directory',
  /** 项目正式制品区：<root>/projects/<projectId>/artifacts（与 F-010 推导一致）。 */
  'artifacts_directory',
  /** 项目 staging 区：<root>/staging/<projectId>（与 F-010 推导一致）。 */
  'staging_directory',
  /** 单制品正式文件：<root>/projects/<projectId>/artifacts/<artifactId>/content。 */
  'artifact_content',
] as const;

export type ProjectResourceType = (typeof PROJECT_RESOURCE_TYPES)[number];

/**
 * 受权定位的资源请求。projectId 可选携带以做归属核对：一旦携带必须与调用绑定的
 * scope.projectId 一致，否则 ownership 拒绝（项目 A 范围不能定位项目 B 的资源）。
 */
export interface ProjectResourceRequest {
  readonly type: ProjectResourceType;
  readonly projectId?: string;
  /** 仅 artifact_content 必填；其余类型携带即拒绝。 */
  readonly artifactId?: string;
}

export function validateProjectResourceRequest(
  value: unknown,
  operation: string,
): ProjectResourceRequest {
  const context: ValidationContext = { operation, entity: { type: 'project' } };
  const object = requirePlainObject(value, context, 'resource');
  rejectUnknownKeys(object, ['type', 'projectId', 'artifactId'], context, 'resource');
  if (typeof object.type !== 'string' || !(PROJECT_RESOURCE_TYPES as readonly string[]).includes(object.type)) {
    throw validationError(
      context,
      'resource.type',
      `必须是已实现的资源类型之一（${PROJECT_RESOURCE_TYPES.join(' / ')}）；Run/Session/Worktree 等类型尚未实现，一律拒绝`,
      object.type,
    );
  }
  const type = object.type as ProjectResourceType;
  const projectId =
    object.projectId === undefined
      ? undefined
      : validateStableId(object.projectId, context, 'resource.projectId');
  if (type === 'artifact_content') {
    if (object.artifactId === undefined) {
      throw validationError(context, 'resource.artifactId', 'artifact_content 定位必须提供 artifactId');
    }
    return {
      type,
      ...(projectId !== undefined ? { projectId } : {}),
      artifactId: validateStableId(object.artifactId, context, 'resource.artifactId'),
    };
  }
  if (object.artifactId !== undefined) {
    throw validationError(
      context,
      'resource.artifactId',
      `仅 artifact_content 允许携带 artifactId（${type} 不接受）`,
    );
  }
  return { type, ...(projectId !== undefined ? { projectId } : {}) };
}

/** 调用时绑定的项目范围：受权定位只允许返回该范围内的位置。 */
export interface ProjectScope {
  readonly projectId: string;
}

export function validateProjectScope(value: unknown, operation: string): ProjectScope {
  const context: ValidationContext = { operation, entity: { type: 'project' } };
  const object = requirePlainObject(value, context, 'scope');
  rejectUnknownKeys(object, ['projectId'], context, 'scope');
  return { projectId: validateStableId(object.projectId, context, 'scope.projectId') };
}

/** 受权定位结果。relativePath 仅作诊断/核对展示；absolutePath 供已授权调用方使用。 */
export interface LocatedPath {
  readonly projectId: string;
  readonly resourceType: ProjectResourceType;
  /** 受控数据根内相对位置（POSIX 分隔）。 */
  readonly relativePath: string;
  /** 已 realpath 数据根推导的绝对位置。 */
  readonly absolutePath: string;
}

/** 资源相对位置纯推导（复用 F-010 制品推导，保证两处一致）。 */
export function deriveResourceRelativePath(
  projectId: string,
  resource: ProjectResourceRequest,
): string {
  switch (resource.type) {
    case 'project_directory':
      return deriveProjectRelativeDir(projectId);
    case 'artifacts_directory':
      return deriveProjectArtifactsRelativeDir(projectId);
    case 'staging_directory':
      return deriveStagingRelativeDir(projectId);
    case 'artifact_content':
      return deriveArtifactFinalRelativePath({
        projectId,
        artifactId: resource.artifactId as string,
      });
  }
}

/**
 * 路径解析运行期错误类别。输入校验失败使用 StorageError(kind='validation')；
 * 项目存在性/归属失败使用 StorageError(not_found/ownership)；本类别只覆盖
 * 数据根与文件系统运行期条件。
 */
export type PathResolutionErrorKind =
  /** 装配参数非法（相对/不存在形态的根、根来源歧义、未装配存在性核验端口等）。 */
  | 'invalid_input'
  /** 路径逃逸或不可信符号链接（祖先 realpath 越出授权根、目标叶为链接等）。 */
  | 'escape'
  /** 数据根不存在。 */
  | 'not_found'
  /** 权限拒绝（EACCES/EPERM）。 */
  | 'permission'
  /** 其他 I/O 失败（details 携带脱敏 code）。 */
  | 'io';

export interface PathResolutionErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * 路径解析运行期错误。消息与 details 只允许出现受控根内相对位置与脱敏错误码，
 * 绝不包含绝对路径（与 F-010 ArtifactFileError 的脱敏约定一致）。
 */
export class PathResolutionError extends Error {
  readonly kind: PathResolutionErrorKind;
  readonly operation: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: PathResolutionErrorKind,
    operation: string,
    message: string,
    options: PathResolutionErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PathResolutionError';
    this.kind = kind;
    this.operation = operation;
    this.details = options.details;
  }
}

export function isPathResolutionError(
  value: unknown,
  kind?: PathResolutionErrorKind,
): value is PathResolutionError {
  return value instanceof PathResolutionError && (kind === undefined || value.kind === kind);
}

/**
 * 受权定位的项目存在性核验端口：StateStore.getProject 的结构子集。未知项目
 * 由实现方抛 StorageError(kind='not_found')；不能仅凭传入 projectId 授权。
 */
export type ProjectExistenceLookup = Pick<StateStore, 'getProject'>;

/**
 * 统一 PathService 窄端口（docs/p01-3-application-contract.md §4.3）。
 *
 * - dataRoot/databaseFilePath/projectDirectory 是纯派生读取（构造时根已 realpath
 *   固定），只校验输入 ID，不核验项目存在性；受权入口是 locateProjectResource；
 * - locateProjectResource 先核验项目存在且资源归属 scope 项目，再返回范围内位置；
 * - 可信项目模式不等于强 OS 沙箱（见文件头说明）。
 */
export interface PathService {
  /** 已 realpath 固定的授权数据根（绝对路径）。 */
  dataRoot(): string;
  /** 状态库文件位置：<dataRoot>/core.sqlite（设计 03 §4 布局）。 */
  databaseFilePath(): string;
  /** 纯推导：<dataRoot>/projects/<projectId>；ID 非法抛 validation。 */
  projectDirectory(projectId: string): string;
  /** 受权定位：存在性 + 归属核验通过后返回范围内位置。 */
  locateProjectResource(scope: ProjectScope, resource: unknown): Promise<LocatedPath>;
}
