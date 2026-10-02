/**
 * F-010 制品文件适配器（adapters 层）：受控逻辑定位、同文件系统 staging 与
 * 路径逃逸防护的真实文件系统实现（ports/artifact-files.ts 契约）。
 *
 * 设计依据：core-design/03 §4（路径通过 ID 和授权根计算，检查 realpath、符号
 * 链接、目录穿越，不拼接不可信标题；staging 与正式文件同文件系统；rename 原子
 * 性不等于断电耐久性，必要 fsync 及目录同步由平台测试确定）。
 *
 * 不变量：
 * - 物理位置只由授权数据根（构造时 realpath 固定）+ 稳定 project/artifact ID
 *   推导；locator 只做契约校验，绝不参与物理路径推导；本模块不读取 displayName、
 *   description、kind 等任何可含用户文本的字段；
 * - 路径安全三层防线：
 *   1. 输入校验（稳定 ID 受限字符集使 .. / 绝对路径 / 分隔符无法进入推导）；
 *   2. 已存在祖先的 realpath 必须位于授权数据根之内（符号链接祖先逃逸在
 *      任何写入/读取之前拒绝）；
 *   3. 文件操作执行 lstat/no-follow 核对（目标叶为符号链接一律拒绝，
 *      读取打开使用 O_NOFOLLOW + fstat 复核常规文件）；
 * - staging 与正式文件结构性地位于同一文件系统（同在数据根之下），发布前仍以
 *   dev 号复核；发布采用 hard link + 移除 staging：link 的 EEXIST 语义保证
 *   “不覆盖已有目标”无检查-操作窗口，同名已有文件保留并返回冲突；
 * - 受限权限：staging/正式文件 0o600，创建的目录 0o700（真实模式经 umask 后的
 *   实际值由测试断言）；finishStaging 在关闭前 fsync 文件，publishStaging 在
 *   移除 staging 前 fsync 正式文件与目录（macOS 平台行为由测试记录）；
 * - 可信项目模式边界：检查（realpath/lstat）与操作（open/link）之间的并发替换
 *   窗口由“单 Host 写入者 + 用户明确授权的可信项目”前提收窄；本适配器不宣称
 *   强 OS 沙箱。关键的“不覆盖”步骤由 link EEXIST 保证，不存在该窗口；
 * - 错误脱敏：ArtifactFileError 的消息与 details 只含受控根内相对位置与错误码，
 *   不含绝对路径或正文内容；输入校验失败抛 StorageError(kind='validation')
 *   （与 F-002 一致），运行期文件条件抛 ArtifactFileError；
 * - 扫描不跟随链接（Dirent 类型 + lstat），每批处理量受 ARTIFACT_FILE_SCAN_*
 *   限制；数据根不存在/权限拒绝显式报错，绝不创建成功假象；
 * - import 本模块无副作用；createArtifactFileStore 只做根核验（realpath/lstat），
 *   不创建任何目录或文件。
 *
 * 本模块不实现：流式发布编排与 hash 核验（F-011）、中断核对与损坏诊断（F-012）、
 * 统一 PathService 的 OS 数据根解析（后续 Feature）、仓库接入。
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { validationError, validateStableId } from '../../ports/validation.js';
import {
  ARTIFACT_FILE_CONTENT_LEAF,
  ARTIFACT_STAGING_FILE_SUFFIX,
  ArtifactFileError,
  deriveArtifactFinalRelativePath,
  deriveProjectArtifactsRelativeDir,
  deriveStagingRelativeDir,
  validateArtifactFileKey,
  validateArtifactFileScanOptions,
} from '../../ports/artifact-files.js';
import type {
  ArtifactFileContent,
  ArtifactFileEntryKind,
  ArtifactFileKey,
  ArtifactFilePlacement,
  ArtifactFileScanEntry,
  ArtifactFileScanPage,
  ArtifactFileStat,
  ArtifactFileStore,
  ArtifactPublishedFile,
  ArtifactStagingFile,
  ArtifactStagingWrite,
} from '../../ports/artifact-files.js';

/** 受限权限：制品正文与 staging 仅属主可读写；受控目录仅属主可进入。 */
const ARTIFACT_FILE_MODE = 0o600;
const ARTIFACT_DIR_MODE = 0o700;

const STAGING_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ArtifactFileStoreOptions {
  /** 授权数据根（绝对路径；必须已存在且为真实目录，构造时 realpath 固定）。 */
  readonly dataRoot: string;
  /** staging 文件名的防碰撞随机成分（默认 randomUUID）；测试注入以获得确定性。 */
  readonly stagingName?: () => string;
}

type NodeError = NodeJS.ErrnoException;

function errorCode(error: unknown): string | undefined {
  return (error as NodeError | null)?.code;
}

/** 运行期文件条件统一映射；消息/details 只含相对位置与错误码（脱敏）。 */
function mapFsError(error: unknown, operation: string, relativePath: string): ArtifactFileError {
  const code = errorCode(error);
  if (code === 'ENOENT') {
    return new ArtifactFileError('not_found', operation, `${operation}: 位置不存在`, {
      details: { relativePath, code },
      cause: error,
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ArtifactFileError('permission', operation, `${operation}: 权限拒绝`, {
      details: { relativePath, code },
      cause: error,
    });
  }
  if (code === 'EEXIST') {
    return new ArtifactFileError('conflict', operation, `${operation}: 目标已存在，按不覆盖策略保留`, {
      details: { relativePath, code },
      cause: error,
    });
  }
  if (code === 'ELOOP') {
    return new ArtifactFileError('escape', operation, `${operation}: 检测到符号链接（no-follow 拒绝）`, {
      details: { relativePath, code, reason: 'symlink_no_follow' },
      cause: error,
    });
  }
  if (code === 'EXDEV') {
    return new ArtifactFileError('io', operation, `${operation}: staging 与正式位置不在同一文件系统`, {
      details: { relativePath, code, reason: 'staging_final_cross_filesystem' },
      cause: error,
    });
  }
  return new ArtifactFileError('io', operation, `${operation}: 文件操作失败（${code ?? 'unknown'}）`, {
    details: { relativePath, code: code ?? 'unknown' },
    cause: error,
  });
}

/**
 * 装配基于真实文件系统的 ArtifactFileStore 端口实现。
 *
 * - dataRoot 必须是已存在的真实目录；构造时经 realpath 固定，此后全部位置推导
 *   都以该真实根为基准（数据根本身经符号链接给出是合法的，如 macOS 的 /tmp）；
 * - 构造只做根核验，不创建任何目录或文件；import 本模块无副作用。
 */
export function createArtifactFileStore(options: ArtifactFileStoreOptions): ArtifactFileStore {
  const operation = 'ArtifactFileStore.create';
  const dataRoot = options?.dataRoot;
  if (typeof dataRoot !== 'string' || dataRoot.length === 0 || !isAbsolute(dataRoot)) {
    throw new ArtifactFileError('invalid_input', operation, `${operation}: dataRoot 必须是绝对路径`, {
      details: { reason: 'data_root_not_absolute' },
    });
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(dataRoot);
    if (!lstatSync(rootReal).isDirectory()) {
      throw new ArtifactFileError('invalid_input', operation, `${operation}: dataRoot 必须是目录`, {
        details: { reason: 'data_root_not_directory' },
      });
    }
  } catch (error) {
    if (error instanceof ArtifactFileError) {
      throw error;
    }
    throw mapFsError(error, operation, '.');
  }
  const stagingName = options.stagingName ?? randomUUID;

  /** 受控根内相对位置 → 绝对路径（词法防线；输入校验已使越界不可能，防御纵深）。 */
  function toAbsolute(relativePath: string, op: string): string {
    const abs = join(rootReal, ...relativePath.split('/'));
    if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
      throw new ArtifactFileError('escape', op, `${op}: 推导位置越出授权数据根`, {
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
          throw new ArtifactFileError(
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
        throw new ArtifactFileError('escape', op, `${op}: 无法定位授权数据根内的祖先`, {
          details: { relativePath, reason: 'no_existing_ancestor' },
        });
      }
      current = parent;
    }
  }

  /** 创建目录（递归、受限权限）并复核其真实位置仍在授权根内。 */
  function ensureDirInsideRoot(absDir: string, relativePath: string, op: string): void {
    assertAncestorsInsideRoot(absDir, relativePath, op);
    try {
      mkdirSync(absDir, { recursive: true, mode: ARTIFACT_DIR_MODE });
    } catch (error) {
      throw mapFsError(error, op, relativePath);
    }
    let real: string;
    try {
      real = realpathSync(absDir);
    } catch (error) {
      throw mapFsError(error, op, relativePath);
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new ArtifactFileError('escape', op, `${op}: 目录真实位置越出授权数据根`, {
        details: { relativePath, reason: 'dir_realpath_outside_root' },
      });
    }
  }

  /**
   * 解析并核验 staging 引用形态：必须恰好是 staging/<projectId>/<安全文件名>，
   * 文件名以 .part 结尾。伪造引用（越区、绝对路径、跨段）一律 validation。
   */
  function parseStagingRef(
    value: unknown,
    op: string,
  ): { projectId: string; relativePath: string } {
    const relativePath =
      typeof value === 'object' && value !== null && 'relativePath' in value
        ? (value as { relativePath: unknown }).relativePath
        : value;
    if (typeof relativePath !== 'string') {
      throw validationError({ operation: op }, 'staging.relativePath', '必须是 staging 区内相对位置', relativePath);
    }
    const segments = relativePath.split('/');
    if (segments.length !== 3 || segments[0] !== 'staging') {
      throw validationError(
        { operation: op },
        'staging.relativePath',
        '必须位于受控 staging 区（staging/<projectId>/<file>.part），拒绝越区引用',
        relativePath,
      );
    }
    const projectId = validateStableId(segments[1], { operation: op }, 'staging.relativePath.projectId');
    const fileName = segments[2] ?? '';
    if (!STAGING_NAME_PATTERN.test(fileName) || !fileName.endsWith(ARTIFACT_STAGING_FILE_SUFFIX)) {
      throw validationError(
        { operation: op },
        'staging.relativePath',
        `staging 文件名必须是受限字符集且以 ${ARTIFACT_STAGING_FILE_SUFFIX} 结尾`,
        relativePath,
      );
    }
    return { projectId, relativePath };
  }

  /** lstat 目标叶：存在且为符号链接 → escape；存在且非常规文件 → not_regular_file。 */
  function assertRegularLeaf(absPath: string, relativePath: string, op: string): void {
    let stat;
    try {
      stat = lstatSync(absPath);
    } catch (error) {
      throw mapFsError(error, op, relativePath);
    }
    if (stat.isSymbolicLink()) {
      throw new ArtifactFileError('escape', op, `${op}: 目标是符号链接，拒绝不可信链接`, {
        details: { relativePath, reason: 'untrusted_symlink' },
      });
    }
    if (!stat.isFile()) {
      throw new ArtifactFileError('not_regular_file', op, `${op}: 目标不是常规文件`, {
        details: { relativePath, reason: 'not_a_regular_file' },
      });
    }
  }

  function scanArea(
    relativeDir: string,
    options: unknown,
    op: string,
  ): ArtifactFileScanPage {
    const scan = validateArtifactFileScanOptions(options, op);
    const absDir = toAbsolute(relativeDir, op);
    let dirStat;
    try {
      dirStat = lstatSync(absDir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        // 项目尚无对应存储区：空页而非错误（与“数据根不存在”区分开，后者在装配期拒绝）。
        return { entries: [], nextCursor: null };
      }
      throw mapFsError(error, op, relativeDir);
    }
    if (dirStat.isSymbolicLink()) {
      throw new ArtifactFileError('escape', op, `${op}: 扫描目录是符号链接，拒绝不可信链接`, {
        details: { relativePath: relativeDir, reason: 'untrusted_symlink' },
      });
    }
    if (!dirStat.isDirectory()) {
      throw new ArtifactFileError('not_regular_file', op, `${op}: 扫描目标不是目录`, {
        details: { relativePath: relativeDir, reason: 'not_a_directory' },
      });
    }
    assertAncestorsInsideRoot(absDir, relativeDir, op);
    let dirents;
    try {
      dirents = readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, op, relativeDir);
    }
    // 名称排序使分页确定；游标为上一页最后一个条目名。
    const names = dirents
      .map((dirent) => dirent.name)
      .filter((name) => scan.cursor === undefined || name > scan.cursor)
      .sort();
    const pageNames = names.slice(0, scan.limit);
    const entries: ArtifactFileScanEntry[] = pageNames.map((name) => {
      const dirent = dirents.find((candidate) => candidate.name === name);
      let kind: ArtifactFileEntryKind = 'other';
      if (dirent?.isFile()) kind = 'file';
      else if (dirent?.isDirectory()) kind = 'directory';
      else if (dirent?.isSymbolicLink()) kind = 'symlink';
      let sizeBytes: number | null = null;
      if (kind === 'file') {
        try {
          sizeBytes = lstatSync(join(absDir, name)).size;
        } catch (error) {
          throw mapFsError(error, op, `${relativeDir}/${name}`);
        }
      }
      return { name, relativePath: `${relativeDir}/${name}`, kind, sizeBytes };
    });
    const nextCursor = names.length > scan.limit ? (pageNames[pageNames.length - 1] ?? null) : null;
    return { entries, nextCursor };
  }

  return {
    resolvePlacement(key: unknown): ArtifactFilePlacement {
      const valid = validateArtifactFileKey(key, 'ArtifactFileStore.resolvePlacement');
      return {
        projectId: valid.projectId,
        artifactId: valid.artifactId,
        finalRelativePath: deriveArtifactFinalRelativePath(valid),
        stagingRelativeDir: deriveStagingRelativeDir(valid.projectId),
      };
    },

    async openStagingWrite(key: unknown): Promise<ArtifactStagingWrite> {
      const op = 'ArtifactFileStore.openStagingWrite';
      const valid = validateArtifactFileKey(key, op);
      const stagingDirRel = deriveStagingRelativeDir(valid.projectId);
      const absDir = toAbsolute(stagingDirRel, op);
      ensureDirInsideRoot(absDir, stagingDirRel, op);
      const randomPart = stagingName();
      if (typeof randomPart !== 'string' || !STAGING_NAME_PATTERN.test(randomPart)) {
        throw new ArtifactFileError('invalid_input', op, `${op}: staging 随机成分不是安全文件名`, {
          details: { relativePath: stagingDirRel, reason: 'staging_name_unsafe' },
        });
      }
      const relativePath = `${stagingDirRel}/${valid.artifactId}.${randomPart}${ARTIFACT_STAGING_FILE_SUFFIX}`;
      const absFile = toAbsolute(relativePath, op);
      let fd: number;
      try {
        fd = openSync(
          absFile,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          ARTIFACT_FILE_MODE,
        );
      } catch (error) {
        throw mapFsError(error, op, relativePath);
      }
      try {
        // autoClose: false——fd 生命周期由 finishStaging/discardStaging 显式管理，
        // 保证 fsync 发生在关闭之前。
        const stream = createWriteStream(relativePath, { fd, autoClose: false });
        // 流错误（如写入失败）经 finishStaging 的 finished() 以结构化 io 错误
        // 透出；此处挂空错误监听，避免 Host 进程因无人监听的 'error' 事件崩溃。
        stream.on('error', () => {});
        return { relativePath, stream };
      } catch (error) {
        closeSync(fd);
        throw mapFsError(error, op, relativePath);
      }
    },

    async finishStaging(write: ArtifactStagingWrite): Promise<ArtifactStagingFile> {
      const op = 'ArtifactFileStore.finishStaging';
      const { relativePath } = parseStagingRef(write?.relativePath, op);
      if (!(write?.stream instanceof Writable)) {
        throw validationError({ operation: op }, 'staging.stream', '必须是 openStagingWrite 返回的写入流');
      }
      const stream = write.stream;
      // fd 由本适配器 openSync 提供；结构化访问避免泄漏 fs.WriteStream 类型到契约面。
      const fd = (stream as { fd?: unknown }).fd;
      try {
        // 调用方必须先 end()；finished 等待流完成或传播流错误（失败不伪装成功）。
        await finished(stream);
      } catch (error) {
        if (typeof fd === 'number') {
          try {
            closeSync(fd);
          } catch {
            // 关闭失败的诊断不覆盖原始流错误。
          }
        }
        throw mapFsError(error, op, relativePath);
      }
      if (typeof fd !== 'number') {
        throw new ArtifactFileError('invalid_input', op, `${op}: staging 写入流没有可用文件描述符`, {
          details: { relativePath, reason: 'staging_fd_missing' },
        });
      }
      try {
        fsyncSync(fd);
        const sizeBytes = fstatSync(fd).size;
        closeSync(fd);
        return { relativePath, sizeBytes };
      } catch (error) {
        try {
          closeSync(fd);
        } catch {
          // 同上：不覆盖原始错误。
        }
        throw mapFsError(error, op, relativePath);
      }
    },

    async publishStaging(staging: ArtifactStagingFile, key: unknown): Promise<ArtifactPublishedFile> {
      const op = 'ArtifactFileStore.publishStaging';
      const valid = validateArtifactFileKey(key, op);
      const ref = parseStagingRef(staging?.relativePath, op);
      if (ref.projectId !== valid.projectId) {
        throw validationError(
          { operation: op },
          'staging.relativePath',
          'staging 引用与目标制品键的项目不一致，拒绝跨项目发布',
          ref.relativePath,
        );
      }
      const absStaging = toAbsolute(ref.relativePath, op);
      // staging 叶必须是真实常规文件（不跟随链接）。
      assertRegularLeaf(absStaging, ref.relativePath, op);
      assertAncestorsInsideRoot(absStaging, ref.relativePath, op);

      const finalRel = deriveArtifactFinalRelativePath(valid);
      const absFinal = toAbsolute(finalRel, op);
      const absFinalDir = dirname(absFinal);
      ensureDirInsideRoot(absFinalDir, finalRel, op);
      // 目标叶：既有符号链接拒绝（escape），既有常规文件/目录由 link EEXIST 兜底为冲突。
      try {
        const target = lstatSync(absFinal);
        if (target.isSymbolicLink()) {
          throw new ArtifactFileError('escape', op, `${op}: 发布目标是符号链接，拒绝不可信链接`, {
            details: { relativePath: finalRel, reason: 'untrusted_symlink' },
          });
        }
        throw new ArtifactFileError('conflict', op, `${op}: 发布目标已存在，按不覆盖策略保留`, {
          details: { relativePath: finalRel, reason: 'target_exists' },
        });
      } catch (error) {
        if (error instanceof ArtifactFileError) {
          throw error;
        }
        if (errorCode(error) !== 'ENOENT') {
          throw mapFsError(error, op, finalRel);
        }
      }
      // 同文件系统复核（结构性保证之外的显式核验；EXDEV 由 link 错误映射兜底）。
      try {
        if (lstatSync(absStaging).dev !== lstatSync(absFinalDir).dev) {
          throw new ArtifactFileError('io', op, `${op}: staging 与正式位置不在同一文件系统`, {
            details: { relativePath: finalRel, reason: 'staging_final_cross_filesystem' },
          });
        }
      } catch (error) {
        if (error instanceof ArtifactFileError) {
          throw error;
        }
        throw mapFsError(error, op, finalRel);
      }
      // 发布：hard link（EEXIST 语义保证不覆盖无窗口）→ fsync 正式文件与目录 → 移除 staging。
      try {
        linkSync(absStaging, absFinal);
      } catch (error) {
        throw mapFsError(error, op, finalRel);
      }
      try {
        const finalFd = openSync(absFinal, constants.O_RDONLY);
        try {
          fsyncSync(finalFd);
        } finally {
          closeSync(finalFd);
        }
        const dirFd = openSync(absFinalDir, constants.O_RDONLY);
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch (error) {
        // 文件与索引（若有）都保持可核对状态：staging 未移除，正式文件已存在，
        // 由 F-012 的中断核对按 pending + 正式文件存在 的恢复路径处理。
        throw mapFsError(error, op, finalRel);
      }
      try {
        unlinkSync(absStaging);
      } catch (error) {
        throw mapFsError(error, op, ref.relativePath);
      }
      return { relativePath: finalRel, sizeBytes: lstatSync(absFinal).size };
    },

    async discardStaging(staging: ArtifactStagingWrite | ArtifactStagingFile): Promise<void> {
      const op = 'ArtifactFileStore.discardStaging';
      const ref = parseStagingRef(staging?.relativePath, op);
      const maybeStream = (staging as ArtifactStagingWrite | undefined)?.stream;
      if (maybeStream !== undefined) {
        if (!(maybeStream instanceof Writable)) {
          throw validationError({ operation: op }, 'staging.stream', '必须是 openStagingWrite 返回的写入流');
        }
        const fd = (maybeStream as { fd?: unknown }).fd;
        maybeStream.destroy();
        if (typeof fd === 'number') {
          try {
            closeSync(fd);
          } catch {
            // 尽力关闭；清理继续。
          }
        }
      }
      const absStaging = toAbsolute(ref.relativePath, op);
      let stat;
      try {
        stat = lstatSync(absStaging);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return; // 幂等：残留已不存在。
        }
        throw mapFsError(error, op, ref.relativePath);
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        // 只移除本适配器创建的常规 staging 文件；未知对象保留并显式报错。
        throw new ArtifactFileError('escape', op, `${op}: staging 位置出现非常规文件，拒绝移除未知对象`, {
          details: { relativePath: ref.relativePath, reason: 'untrusted_staging_object' },
        });
      }
      assertAncestorsInsideRoot(absStaging, ref.relativePath, op);
      try {
        unlinkSync(absStaging);
      } catch (error) {
        throw mapFsError(error, op, ref.relativePath);
      }
    },

    async openFinalRead(key: unknown): Promise<ArtifactFileContent> {
      const op = 'ArtifactFileStore.openFinalRead';
      const valid = validateArtifactFileKey(key, op);
      const finalRel = deriveArtifactFinalRelativePath(valid);
      const absFinal = toAbsolute(finalRel, op);
      assertAncestorsInsideRoot(absFinal, finalRel, op);
      assertRegularLeaf(absFinal, finalRel, op);
      let fd: number;
      try {
        // no-follow 打开 + fstat 复核：检查与打开之间的链接替换被 O_NOFOLLOW 拦截。
        const noFollow = constants.O_NOFOLLOW ?? 0;
        fd = openSync(absFinal, constants.O_RDONLY | noFollow);
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
          closeSync(fd);
          throw new ArtifactFileError('not_regular_file', op, `${op}: 目标不是常规文件`, {
            details: { relativePath: finalRel, reason: 'not_a_regular_file' },
          });
        }
        const stream = createReadStream(finalRel, { fd, autoClose: true });
        return { relativePath: finalRel, sizeBytes: stat.size, stream };
      } catch (error) {
        if (error instanceof ArtifactFileError) {
          throw error;
        }
        throw mapFsError(error, op, finalRel);
      }
    },

    async statFinal(key: unknown): Promise<ArtifactFileStat> {
      const op = 'ArtifactFileStore.statFinal';
      const valid = validateArtifactFileKey(key, op);
      const finalRel = deriveArtifactFinalRelativePath(valid);
      const absFinal = toAbsolute(finalRel, op);
      assertAncestorsInsideRoot(absFinal, finalRel, op);
      assertRegularLeaf(absFinal, finalRel, op);
      const stat = lstatSync(absFinal);
      return { relativePath: finalRel, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
    },

    async scanFinalArea(projectId: string, options?: unknown): Promise<ArtifactFileScanPage> {
      const op = 'ArtifactFileStore.scanFinalArea';
      const validProjectId = validateStableId(projectId, { operation: op }, 'projectId');
      return scanArea(deriveProjectArtifactsRelativeDir(validProjectId), options, op);
    },

    async scanStagingArea(projectId: string, options?: unknown): Promise<ArtifactFileScanPage> {
      const op = 'ArtifactFileStore.scanStagingArea';
      const validProjectId = validateStableId(projectId, { operation: op }, 'projectId');
      return scanArea(deriveStagingRelativeDir(validProjectId), options, op);
    },
  };
}
