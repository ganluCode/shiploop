/**
 * P01-3 / F-004 只读仓库路径检查窄契约（ports 契约层：类型、常量、纯校验与
 * 纯派生函数，无任何 I/O 与子进程）。
 *
 * 设计依据：core-design/06 §1（project init：规范路径 + Git 与脏状态识别；相同
 * 规范路径重复 init 返回已有项目；同 remote 不同 clone 可注册不同项目；已有脏
 * 工作区不自动 stash/reset；无初始 commit 提示而不猜 main 分支）、
 * core-design/03 §1（repository_bindings：canonical_path 全库唯一、
 * repo_identity 必填、remote 非唯一身份）与 docs/p01-3-application-contract.md
 * §4.2。
 *
 * 契约要点：
 * - 只读：实现不得执行仓库脚本、npm install、commit、stash、reset、fetch 或任何
 *   写操作；Git/文件系统检查发生在数据库写事务之外（适配器不接触存储端口）；
 * - canonicalPath 为输入仓库根 realpath 规范化后的真实路径；repoIdentity 为稳定
 *   本地身份（deriveRepoIdentity，gitCommonDir realpath 的 SHA-256 派生）：同
 *   clone 重检一致、同 remote 不同 clone 不合并；remote 只作信息，绝不参与身份；
 * - 支持范围（F-004 实施契约，见契约文档 §4.2 与 §9-6，请求核对）：接受工作树根
 *   （含无初始 commit、脏工作区）、根的符号链接别名与 linked worktree 顶层；拒绝
 *   不存在路径、普通文件、非 Git 目录、仓库子目录（repository_root_required，不
 *   误绑定到外层仓库）、裸仓库与 .git 内部目录（bare_repository /
 *   not_a_worktree_root）；
 * - 错误脱敏：RepositoryInspectionError 携带 operation 与结构化 reason 码；
 *   message/details 只含 reason 码与退出码/信号等可序列化字段，不含绝对路径、
 *   stderr 原文或凭据；超时/不可用/权限错误绝不伪装成有效绑定；
 * - 本文件为纯契约：不导入文件系统、子进程、网络、Pi SDK 或 ORM 模块；
 *   deriveRepoIdentity 为确定性哈希纯计算（node:crypto，无 I/O）。
 *
 * 实现者：adapters/fs/repository-inspector.ts（F-004）；组合根（F-012）装配；
 * ProjectService.registerRepository（F-005）在写事务之外调用本端口。
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

/** repoIdentity 派生前缀：gitCommonDir realpath 的 SHA-256（稳定本地身份）。 */
export const REPO_IDENTITY_PREFIX = 'gitdir-sha256:';

/** Git 单次只读调用的默认有限超时（毫秒）。 */
export const REPOSITORY_INSPECTION_DEFAULT_TIMEOUT_MS = 10_000;
/** Git 单次只读调用允许的最大超时（毫秒）：防止装配出无界等待。 */
export const REPOSITORY_INSPECTION_MAX_TIMEOUT_MS = 120_000;
/** Git 单次只读调用的默认输出上限（字节）：防无界内存占用。 */
export const REPOSITORY_INSPECTION_DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
/** Git 单次只读调用允许的最大输出上限（字节）。 */
export const REPOSITORY_INSPECTION_MAX_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * 仓库检查运行期错误类别。输入校验失败使用 invalid_input（与 F-002 的
 * StorageError(kind='validation') 角色对应，属仓库检查自己的窄错误类型，
 * 见契约文档 §7.3）；其余类别覆盖文件系统与 Git 运行期条件。
 */
export type RepositoryInspectionErrorKind =
  /** 输入非法（非字符串/空/相对路径/含 NUL）或装配参数非法。 */
  | 'invalid_input'
  /** 路径不存在。 */
  | 'not_found'
  /** 路径存在但不是目录（普通文件等）。 */
  | 'not_a_directory'
  /** 不是受支持的仓库根：非 Git 目录、仓库子目录、裸仓库、.git 内部目录。 */
  | 'not_a_repository'
  /** Git 可执行文件不可用（ENOENT）。 */
  | 'unavailable'
  /** Git 调用超出有限超时被终止。 */
  | 'timeout'
  /** 权限拒绝（Git 不可执行、文件系统 EACCES/EPERM）。 */
  | 'permission'
  /** 其他 I/O 失败：Git 非零退出、输出超限、输出形态无法解析等。 */
  | 'io';

export interface RepositoryInspectionErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * 仓库检查运行期错误。message 与 details 只允许出现 operation、结构化 reason
 * 码与退出码/信号等可序列化字段，绝不包含绝对路径、stderr 原文或凭据（与
 * PathResolutionError 的脱敏约定一致）。
 */
export class RepositoryInspectionError extends Error {
  readonly kind: RepositoryInspectionErrorKind;
  readonly operation: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: RepositoryInspectionErrorKind,
    operation: string,
    message: string,
    options: RepositoryInspectionErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RepositoryInspectionError';
    this.kind = kind;
    this.operation = operation;
    this.details = options.details;
  }
}

export function isRepositoryInspectionError(
  value: unknown,
  kind?: RepositoryInspectionErrorKind,
): value is RepositoryInspectionError {
  return (
    value instanceof RepositoryInspectionError && (kind === undefined || value.kind === kind)
  );
}

/**
 * 仓库路径输入纯校验：必须是不含 NUL 的非空 POSIX 绝对路径。
 * Core 没有"当前工作目录"语义，相对路径一律拒绝（由调用方/Host 先规范化）。
 */
export function validateRepositoryInspectionPath(value: unknown, operation: string): string {
  if (typeof value !== 'string') {
    throw new RepositoryInspectionError(
      'invalid_input',
      operation,
      `${operation}: 仓库路径必须是字符串`,
      { details: { reason: 'path_not_string' } },
    );
  }
  if (value.trim().length === 0) {
    throw new RepositoryInspectionError(
      'invalid_input',
      operation,
      `${operation}: 仓库路径不能为空`,
      { details: { reason: 'path_empty' } },
    );
  }
  if (value.includes('\0')) {
    throw new RepositoryInspectionError(
      'invalid_input',
      operation,
      `${operation}: 仓库路径不允许包含 NUL 字节`,
      { details: { reason: 'path_nul' } },
    );
  }
  if (!isAbsolute(value)) {
    throw new RepositoryInspectionError(
      'invalid_input',
      operation,
      `${operation}: 仓库路径必须是绝对路径（Core 无 cwd 语义）`,
      { details: { reason: 'path_not_absolute' } },
    );
  }
  return value;
}

/**
 * 稳定本地仓库身份纯派生：REPO_IDENTITY_PREFIX + sha256(gitCommonDirRealPath)。
 *
 * - 确定性：同一 gitCommonDir realpath 恒得同一身份（关闭重开、符号链接别名一致）；
 * - 区分 clone：不同 clone 的公共目录不同，同 remote 不合并（设计 03 §1）；
 * - 不含路径原文：身份可安全进入索引/日志而不泄漏本地路径；
 * - linked worktree 与主 checkout 共享公共目录：身份一致而 canonicalPath 不同，
 *   canonical_path 唯一约束仍把不同 checkout 分开（见契约文档 §4.2）。
 */
export function deriveRepoIdentity(gitCommonDirRealPath: unknown): string {
  if (typeof gitCommonDirRealPath !== 'string' || gitCommonDirRealPath.length === 0) {
    throw new RepositoryInspectionError(
      'invalid_input',
      'deriveRepoIdentity',
      'deriveRepoIdentity: gitCommonDirRealPath 必须是非空字符串（已 realpath 的公共目录）',
      { details: { reason: 'git_common_dir_invalid' } },
    );
  }
  const digest = createHash('sha256').update(gitCommonDirRealPath, 'utf8').digest('hex');
  return `${REPO_IDENTITY_PREFIX}${digest}`;
}

/**
 * 只读仓库身份检查结果（契约文档 §4.2）。
 *
 * 注意：结构合法/检查成功 ≠ 项目已注册或配置可执行；本结果只描述本地仓库事实。
 */
export interface RepositoryInspection {
  /** realpath 规范化后的仓库根（符号链接别名解析到同一值）。 */
  readonly canonicalPath: string;
  /**
   * `git rev-parse --git-common-dir` 解析并 realpath 规范化后的公共元数据目录；
   * 对受支持的布局恒为非空（裸仓库已在此前拒绝）。类型保留 null 以与存储列
   * （git_common_dir 可空）和前向兼容布局对齐。
   */
  readonly gitCommonDir: string | null;
  /** 稳定本地身份（deriveRepoIdentity）；remote 只作信息，不参与身份。 */
  readonly repoIdentity: string;
  /** 当前 HEAD 提交（无初始 commit 时为 null；不猜 main、不自动 commit）。 */
  readonly headCommit: string | null;
  readonly hasInitialCommit: boolean;
  /** 工作区是否有未提交变更（含未跟踪文件）；已有脏工作区不自动 stash/reset。 */
  readonly hasUncommittedChanges: boolean;
}

/**
 * 只读仓库路径检查窄端口（契约文档 §4.2）。
 *
 * 实现必须使用独立 argv、显式 cwd、有限超时与输出上限调用 Git，不拼接 shell；
 * 失败返回 RepositoryInspectionError，绝不伪装成有效绑定。
 */
export interface RepositoryInspector {
  inspect(repositoryPath: unknown): Promise<RepositoryInspection>;
}
