/**
 * P01-3 / F-003 统一 PathService 文件系统适配器（adapters 层，
 * ports/path-service.ts 契约的真实实现）。
 *
 * 设计依据：core-design/01 §4（稳定 namespace 数据根，PathService 集中解析）、
 * core-design/03 §4（路径通过 ID 和授权根计算，检查 realpath、符号链接、目录
 * 穿越）与 docs/p01-3-application-contract.md §4.3。
 *
 * 不变量：
 * - 授权数据根在构造时 realpath 固定，此后全部位置推导以该真实根为基准；显式根
 *   必须已存在且为真实目录（经符号链接给出合法，如 macOS /tmp）；默认根由注入的
 *   macOS 用户目录纯推导（deriveDefaultDataRoot），本模块不读取进程真实用户目录，
 * - 本项目只解析与使用已存在根：构造不创建任何目录或文件，不隐式迁移源仓库；
 * - 路径安全三层防线（沿用 F-010 制品文件适配器的核对方式）：
 *   1. 输入校验（validateStableId 受限字符集使 .. / 绝对路径 / 分隔符无法进入推导）；
 *   2. 已存在祖先的 realpath 必须位于授权数据根之内（符号链接祖先逃逸在返回
 *      位置之前拒绝）；
 *   3. 目标叶存在时执行 lstat 核对：符号链接一律 escape 拒绝（不跟随）；
 * - 受权定位核验「项目真实存在 + 资源归属调用绑定的项目范围」：存在性由装配注入
 *   的 ProjectExistenceLookup（StateStore.getProject）核验；未装配核验端口时
 *   fail-closed（invalid_input），不能仅凭传入 projectId 授权；
 * - 错误脱敏：StorageError（validation/not_found/ownership）与 PathResolutionError
 *   的消息与 details 只含受控根内相对位置、稳定 ID 与脱敏错误码，不含绝对路径；
 * - 可信项目模式边界：检查（realpath/lstat）与后续文件操作之间的并发替换窗口由
 *   “单 Host 写入者 + 用户明确授权的可信项目”前提收窄；本适配器不宣称强 OS 沙箱；
 * - import 本模块无副作用；createPathService 只做根核验（realpath/lstat），不创建
 *   任何目录或文件。
 *
 * 本模块不实现：Run/Session/Worktree 等未实现目录类型、Host/CLI 装配（F-012）、
 * 制品文件读写（F-010 ArtifactFileStore 的职责）。
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import {
  DATABASE_FILE_NAME,
  PathResolutionError,
  deriveDefaultDataRoot,
  deriveProjectRelativeDir,
  deriveResourceRelativePath,
  validateProjectResourceRequest,
  validateProjectScope,
} from '../../ports/path-service.js';
import type {
  LocatedPath,
  PathService,
  ProjectExistenceLookup,
  ProjectScope,
} from '../../ports/path-service.js';

type NodeError = NodeJS.ErrnoException;

function errorCode(error: unknown): string | undefined {
  return (error as NodeError | null)?.code;
}

/** 运行期文件条件统一映射；消息/details 只含相对位置与脱敏错误码。 */
function mapFsError(error: unknown, operation: string, relativePath: string): PathResolutionError {
  const code = errorCode(error);
  if (code === 'ENOENT') {
    return new PathResolutionError('not_found', operation, `${operation}: 位置不存在`, {
      details: { relativePath, code },
      cause: error,
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new PathResolutionError('permission', operation, `${operation}: 权限拒绝`, {
      details: { relativePath, code },
      cause: error,
    });
  }
  if (code === 'ELOOP') {
    return new PathResolutionError('escape', operation, `${operation}: 检测到符号链接（no-follow 拒绝）`, {
      details: { relativePath, code, reason: 'symlink_no_follow' },
      cause: error,
    });
  }
  return new PathResolutionError('io', operation, `${operation}: 文件操作失败（${code ?? 'unknown'}）`, {
    details: { relativePath, code: code ?? 'unknown' },
    cause: error,
  });
}

export interface PathServiceOptions {
  /** 显式授权数据根（绝对路径；必须已存在且为真实目录，构造时 realpath 固定）。 */
  readonly dataRoot?: string;
  /** 注入的 macOS 用户目录：用于解析默认根（测试注入临时 home，不读取真实用户目录）。 */
  readonly userHomeDir?: string;
  /** 项目存在性核验端口；未装配时 locateProjectResource fail-closed。 */
  readonly projectLookup?: ProjectExistenceLookup;
}

/** 适配器返回形态：在 PathService 端口之上提供装配期延迟绑定存在性核验端口。 */
export interface FsPathService extends PathService {
  /**
   * 返回共享同一已解析数据根、并装配项目存在性核验端口的 PathService。
   * 组合根顺序：先解析数据根 → 打开数据库/存储 → 再以 StateStore 绑定核验端口。
   */
  withProjectLookup(lookup: ProjectExistenceLookup): FsPathService;
}

/**
 * 装配基于真实文件系统的 PathService 端口实现。
 *
 * - dataRoot 与 userHomeDir 必须且只能提供其一；两者都经校验与规范化后才返回；
 * - 构造只做根核验（realpath/lstat），不创建任何目录或文件；import 无副作用。
 */
export function createPathService(options: PathServiceOptions): FsPathService {
  const operation = 'PathService.create';
  const hasDataRoot = options?.dataRoot !== undefined;
  const hasUserHome = options?.userHomeDir !== undefined;
  if (hasDataRoot === hasUserHome) {
    throw new PathResolutionError(
      'invalid_input',
      operation,
      `${operation}: 必须且只能提供 dataRoot 或 userHomeDir 之一`,
      { details: { reason: 'root_source_ambiguous' } },
    );
  }
  const candidate = hasDataRoot
    ? validateExplicitRoot(options.dataRoot as string, operation)
    : deriveDefaultDataRoot(options.userHomeDir, operation);
  const rootReal = resolveExistingRoot(candidate, operation);
  const lookup =
    options.projectLookup === undefined ? undefined : validateLookup(options.projectLookup, operation);
  return buildService(rootReal, lookup);
}

function validateExplicitRoot(dataRoot: string, operation: string): string {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0 || !isAbsolute(dataRoot)) {
    throw new PathResolutionError('invalid_input', operation, `${operation}: dataRoot 必须是绝对路径`, {
      details: { reason: 'data_root_not_absolute' },
    });
  }
  if (dataRoot.includes('\0')) {
    throw new PathResolutionError('invalid_input', operation, `${operation}: dataRoot 不允许包含 NUL 字节`, {
      details: { reason: 'data_root_nul' },
    });
  }
  return dataRoot;
}

/** 根必须已存在且为真实目录；只解析与核验，不创建。 */
function resolveExistingRoot(candidate: string, operation: string): string {
  let rootReal: string;
  try {
    rootReal = realpathSync(candidate);
  } catch (error) {
    throw mapFsError(error, operation, '.');
  }
  if (rootReal === sep) {
    throw new PathResolutionError('invalid_input', operation, `${operation}: 拒绝把文件系统根作为数据根`, {
      details: { reason: 'data_root_unsafe' },
    });
  }
  let stat;
  try {
    stat = lstatSync(rootReal);
  } catch (error) {
    throw mapFsError(error, operation, '.');
  }
  if (!stat.isDirectory()) {
    throw new PathResolutionError('invalid_input', operation, `${operation}: dataRoot 必须是目录`, {
      details: { reason: 'data_root_not_directory' },
    });
  }
  return rootReal;
}

function validateLookup(lookup: unknown, operation: string): ProjectExistenceLookup {
  if (
    lookup === null ||
    typeof lookup !== 'object' ||
    typeof (lookup as { getProject?: unknown }).getProject !== 'function'
  ) {
    throw new PathResolutionError(
      'invalid_input',
      operation,
      `${operation}: projectLookup 必须提供 getProject 存在性核验（StateStore 结构子集）`,
      { details: { reason: 'project_lookup_invalid' } },
    );
  }
  return lookup as ProjectExistenceLookup;
}

function buildService(rootReal: string, projectLookup: ProjectExistenceLookup | undefined): FsPathService {
  /** 受控根内相对位置 → 绝对路径（词法防线；输入校验已使越界不可能，防御纵深）。 */
  function toAbsolute(relativePath: string, op: string): string {
    const abs = join(rootReal, ...relativePath.split('/'));
    if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
      throw new PathResolutionError('escape', op, `${op}: 推导位置越出授权数据根`, {
        details: { relativePath, reason: 'derived_path_outside_root' },
      });
    }
    return abs;
  }

  /** 已存在祖先的 realpath 必须位于授权根之内（符号链接祖先防线）。 */
  function assertAncestorsInsideRoot(absPath: string, relativePath: string, op: string): void {
    let current = absPath;
    for (;;) {
      let exists = false;
      try {
        exists = existsSync(current);
      } catch (error) {
        throw mapFsError(error, op, relativePath);
      }
      if (exists) {
        let real: string;
        try {
          real = realpathSync(current);
        } catch (error) {
          throw mapFsError(error, op, relativePath);
        }
        if (real !== rootReal && !real.startsWith(rootReal + sep)) {
          throw new PathResolutionError(
            'escape',
            op,
            `${op}: 已存在祖先的真实位置越出授权数据根（符号链接逃逸）`,
            { details: { relativePath, reason: 'ancestor_realpath_outside_root' } },
          );
        }
        return;
      }
      const parent = dirname(current);
      if (parent === current) {
        // 不可达（rootReal 已存在），防御纵深。
        throw new PathResolutionError('escape', op, `${op}: 无法定位授权数据根内的祖先`, {
          details: { relativePath, reason: 'no_existing_ancestor' },
        });
      }
      current = parent;
    }
  }

  /** 目标叶存在时核对：符号链接一律 escape（不跟随、不穿透）。 */
  function assertLeafNotSymlink(absPath: string, relativePath: string, op: string): void {
    let stat;
    try {
      stat = lstatSync(absPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return; // 目标尚不存在是合法的（定位 ≠ 读取）。
      }
      throw mapFsError(error, op, relativePath);
    }
    if (stat.isSymbolicLink()) {
      throw new PathResolutionError('escape', op, `${op}: 目标是符号链接，拒绝不可信链接`, {
        details: { relativePath, reason: 'untrusted_symlink' },
      });
    }
  }

  const service: FsPathService = {
    dataRoot(): string {
      return rootReal;
    },

    databaseFilePath(): string {
      return toAbsolute(DATABASE_FILE_NAME, 'PathService.databaseFilePath');
    },

    projectDirectory(projectId: string): string {
      const op = 'PathService.projectDirectory';
      const validId = validateStableId(projectId, { operation: op }, 'projectId');
      return toAbsolute(deriveProjectRelativeDir(validId), op);
    },

    async locateProjectResource(scope: ProjectScope, resource: unknown): Promise<LocatedPath> {
      const op = 'PathService.locateProjectResource';
      const validScope = validateProjectScope(scope, op);
      const validResource = validateProjectResourceRequest(resource, op);
      if (validResource.projectId !== undefined && validResource.projectId !== validScope.projectId) {
        throw new StorageError(
          'ownership',
          op,
          `${op}: 资源归属项目与调用绑定的项目范围不一致，拒绝跨项目定位`,
          {
            entity: { type: 'project', id: validScope.projectId },
            details: { field: 'resource.projectId', reason: 'cross_project_scope' },
          },
        );
      }
      if (projectLookup === undefined) {
        throw new PathResolutionError(
          'invalid_input',
          op,
          `${op}: 未装配项目存在性核验端口，拒绝仅凭传入 projectId 授权`,
          {
            details: {
              relativePath: deriveProjectRelativeDir(validScope.projectId),
              reason: 'project_lookup_not_configured',
            },
          },
        );
      }
      // 存在性核验：未知项目由 StateStore 抛 StorageError(kind='not_found')，原样透出。
      await projectLookup.getProject(validScope.projectId);
      const relativePath = deriveResourceRelativePath(validScope.projectId, validResource);
      const absolutePath = toAbsolute(relativePath, op);
      assertAncestorsInsideRoot(absolutePath, relativePath, op);
      assertLeafNotSymlink(absolutePath, relativePath, op);
      return {
        projectId: validScope.projectId,
        resourceType: validResource.type,
        relativePath,
        absolutePath,
      };
    },

    withProjectLookup(lookup: ProjectExistenceLookup): FsPathService {
      return buildService(rootReal, validateLookup(lookup, 'PathService.withProjectLookup'));
    },
  };
  return service;
}
