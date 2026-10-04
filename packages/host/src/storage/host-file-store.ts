/**
 * F-003 受保护 Host 文件存储（§3.3 布局与权限、§4.2 凭据、§5.2 原子发布、
 * §10.5 按实例清理）。
 *
 * 不变量：
 * - 只接受已经 realpath 固定的规范根（createHostFileStore 防御性复核：
 *   realpathSync 结果必须与入参逐字符一致，且是真实目录）；
 * - host/ 目录 0700、discovery.json/auth.token 0600、属主为当前进程用户；
 *   权限过宽、符号链接（含根外逃逸）、非普通文件一律 fail-closed：拒绝信任、
 *   不 chmod「修复」、不覆盖可疑位置；
 * - 凭据由 node:crypto randomBytes(32) 生成（64 位小写 hex）；只写入受保护文件，
 *   从不进入错误消息、details 或返回值之外的位置；
 * - 发布走同目录受控临时文件（.discovery.json.<uuid>.tmp，0600，'wx' 排他创建）
 *   + fsync + rename 原子替换；发布失败清理临时文件，不留下可连接的半文件；
 * - 清理须由调用方在持有本规范根 OS 写入锁（F-004）后调用；本模块再核对
 *   discovery.json 中的 hostInstanceId 与预期实例一致才删除发现与凭据，
 *   绝不删除、移动或替换 writer.lock；
 * - 错误消息与 details 只含受控相对位置（host/discovery.json 等）与 errno 码，
 *   不含绝对路径、凭据或文件原文；
 * - 首版仅 macOS：非 darwin 平台一律 unsupported_platform（§2.2/§6）。
 *
 * 本模块不实现：OS 锁（F-004）、HTTP 传输（F-007）、启动顺序编排（F-006）。
 * import 本模块无副作用：不创建目录/文件、不读用户目录、不监听端口、不启动进程。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import {
  assertDiscoveryForLocalRoot,
  computeDataRootIdentity,
  HostProtocolError,
  isSha256Hex,
  isUuidV4,
  parseDiscoveryText,
  validateDiscoveryRecord,
} from '../contract/index.js';
import type { HostDiscoveryRecord } from '../contract/index.js';
import {
  AUTH_TOKEN_FILE_NAME,
  AUTH_TOKEN_RELATIVE_PATH,
  DISCOVERY_FILE_NAME,
  DISCOVERY_RELATIVE_PATH,
  HOST_DIR_MODE,
  HOST_DIR_NAME,
  HOST_DIR_RELATIVE_PATH,
  PROTECTED_FILE_MODE,
  WRITER_LOCK_FILE_NAME,
} from './layout.js';

const OPERATION = 'host.discovery';

/** §14 仅客户端码：本地文件不可信（权限/属主/符号链接/形态）。 */
function unsafeDiscovery(reason: string, relativePath: string): HostProtocolError {
  return new HostProtocolError('unsafe_discovery', OPERATION, `拒绝信任不安全的 ${relativePath}`, {
    details: { relativePath, reason },
  });
}

function invalidDiscovery(reason: string, relativePath: string): HostProtocolError {
  return new HostProtocolError('invalid_discovery', OPERATION, `${relativePath} 内容无效`, {
    details: { relativePath, reason },
  });
}

function ioFailure(reason: string, relativePath: string, cause: unknown): HostProtocolError {
  return new HostProtocolError('internal', OPERATION, `文件操作失败（${relativePath}）`, {
    details: {
      relativePath,
      reason,
      fsCode: (cause as NodeJS.ErrnoException | null)?.code ?? 'unknown',
    },
    cause,
  });
}

function fsCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export interface HostFileStoreOptions {
  /** 已 realpath 固定的规范根（resolveCanonicalDataRoot 的输出）。 */
  readonly canonicalRoot: string;
  /** 平台注入口（默认 process.platform）；仅 'darwin' 受支持。 */
  readonly platform?: string;
}

export type HostCleanupOutcome =
  | 'cleaned'
  | 'skipped_host_dir_absent'
  | 'skipped_host_dir_unsafe'
  | 'skipped_discovery_absent'
  | 'skipped_discovery_unsafe'
  | 'skipped_discovery_invalid'
  | 'skipped_instance_mismatch'
  | 'skipped_token_unsafe';

export interface HostCleanupResult {
  readonly outcome: HostCleanupOutcome;
  readonly deletedDiscovery: boolean;
  readonly deletedAuthToken: boolean;
}

export interface HostFileStore {
  /** 规范根（realpath 原样字符串）。 */
  readonly canonicalRoot: string;
  /** §3.2 数据根身份。 */
  readonly dataRootIdentity: string;
  /** 创建（0700）或核验既有 host/ 目录；不安全形态 fail-closed。 */
  ensureHostDir(): void;
  /** 生成新凭据并原子写入 host/auth.token（0600）；返回凭据本身。 */
  issueAuthToken(): string;
  /** fail-closed 核验后读取凭据；格式非法/不安全/缺失均拒绝。 */
  readTrustedAuthToken(): string;
  /** 校验并原子发布发现；数据根身份与本地不一致或目标可疑时拒绝。 */
  publishDiscovery(record: HostDiscoveryRecord): void;
  /** 按 §5.2 读取信任条件核验并返回发现记录。 */
  readTrustedDiscovery(): HostDiscoveryRecord;
  /**
   * 按实例清理发现与凭据（§10.5 第 5 步）。
   *
   * 调用前提：调用方持有本规范根的 OS 写入锁（F-004）；本方法再核对
   * discovery.json 的 hostInstanceId，身份不一致或无法核对时 fail-closed
   * 跳过（不删除任何文件）。writer.lock 绝不被本方法删除、移动或替换。
   */
  cleanupInstanceFiles(expectedInstanceId: string): HostCleanupResult;
}

/**
 * 在规范根上建立 Host 文件存储。构造只做规范根复核（realpath 一致性与目录
 * 核验），不创建任何目录或文件。
 */
export function createHostFileStore(options: HostFileStoreOptions): HostFileStore {
  const platform = options?.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new HostProtocolError('unsupported_platform', OPERATION, '首版仅正式支持 macOS', {
      details: { reason: 'platform_not_darwin' },
    });
  }
  if (typeof process.getuid !== 'function') {
    throw new HostProtocolError('unsupported_platform', OPERATION, '平台缺少 POSIX 属主核验能力', {
      details: { reason: 'getuid_unavailable' },
    });
  }
  const canonicalRoot = options?.canonicalRoot;
  if (typeof canonicalRoot !== 'string' || canonicalRoot.length === 0 || canonicalRoot.includes('\0')) {
    throw new HostProtocolError('invalid_input', OPERATION, 'canonicalRoot 必须是非空且不含 NUL 的字符串', {
      details: { field: 'canonicalRoot', reason: 'invalid_root_type' },
    });
  }
  let real: string;
  try {
    real = realpathSync(canonicalRoot);
  } catch (error) {
    throw new HostProtocolError('invalid_input', OPERATION, '规范根不存在或不可解析', {
      details: { field: 'canonicalRoot', reason: 'root_unresolvable', fsCode: fsCode(error) ?? 'unknown' },
      cause: error,
    });
  }
  if (real !== canonicalRoot) {
    throw new HostProtocolError('invalid_input', OPERATION, 'canonicalRoot 必须经 realpath 固定（拒绝路径别名）', {
      details: { field: 'canonicalRoot', reason: 'root_not_canonical' },
    });
  }
  if (!statSync(canonicalRoot).isDirectory()) {
    throw new HostProtocolError('invalid_input', OPERATION, '规范根必须是目录', {
      details: { field: 'canonicalRoot', reason: 'not_a_directory' },
    });
  }

  const uid = process.getuid();
  const hostDir = join(canonicalRoot, HOST_DIR_NAME);
  const discoveryPath = join(hostDir, DISCOVERY_FILE_NAME);
  const authTokenPath = join(hostDir, AUTH_TOKEN_FILE_NAME);
  const dataRootIdentity = computeDataRootIdentity(canonicalRoot);

  function lstatOrNull(path: string): Stats | null {
    try {
      return lstatSync(path);
    } catch (error) {
      if (fsCode(error) === 'ENOENT') {
        return null;
      }
      throw ioFailure('lstat_failed', HOST_DIR_RELATIVE_PATH, error);
    }
  }

  /** 目录 fail-closed 核验：真实目录、0700、当前用户所有、未逃逸出规范根。 */
  function assertProtectedHostDir(stats: Stats): void {
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeDiscovery('not_a_real_directory', HOST_DIR_RELATIVE_PATH);
    }
    if ((stats.mode & 0o777) !== HOST_DIR_MODE) {
      throw unsafeDiscovery('permissions_too_open', HOST_DIR_RELATIVE_PATH);
    }
    if (stats.uid !== uid) {
      throw unsafeDiscovery('ownership_mismatch', HOST_DIR_RELATIVE_PATH);
    }
    if (realpathSync(hostDir) !== hostDir) {
      throw unsafeDiscovery('symlink_escape', HOST_DIR_RELATIVE_PATH);
    }
  }

  /** 受保护文件 fail-closed 核验：普通文件、0600、当前用户所有。 */
  function assertProtectedFile(stats: Stats, relativePath: string): void {
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw unsafeDiscovery('not_a_regular_file', relativePath);
    }
    if ((stats.mode & 0o777) !== PROTECTED_FILE_MODE) {
      throw unsafeDiscovery('permissions_too_open', relativePath);
    }
    if (stats.uid !== uid) {
      throw unsafeDiscovery('ownership_mismatch', relativePath);
    }
  }

  function verifyHostDirForRead(): void {
    const stats = lstatOrNull(hostDir);
    if (stats === null) {
      throw new HostProtocolError('host_not_found', OPERATION, '未发现运行中的 Host（缺少 Host 私有目录）', {
        details: { relativePath: HOST_DIR_RELATIVE_PATH, reason: 'host_dir_absent' },
      });
    }
    assertProtectedHostDir(stats);
  }

  /**
   * 同目录原子发布：'wx' 排他创建随机名临时文件（0600）→ 完整写入 + fsync →
   * rename 原子替换 → 目录 fsync。失败时尽力删除临时文件，绝不留下可连接的
   * 半文件；既有目标若可疑（符号链接/非普通文件/权限过宽/他人所有）整体拒绝，
   * 不覆盖可疑位置。
   */
  function atomicPublishFile(fileName: string, relativePath: string, content: string): void {
    const hostDirStats = lstatOrNull(hostDir);
    if (hostDirStats === null) {
      throw invalidDiscovery('host_dir_absent', HOST_DIR_RELATIVE_PATH);
    }
    assertProtectedHostDir(hostDirStats);

    const target = join(hostDir, fileName);
    const existing = lstatOrNull(target);
    if (existing !== null) {
      assertProtectedFile(existing, relativePath);
    }

    const tmpName = `.${fileName}.${randomUUID()}.tmp`;
    const tmpPath = join(hostDir, tmpName);
    let renamed = false;
    try {
      const fd = openSync(tmpPath, 'wx', PROTECTED_FILE_MODE);
      try {
        writeFileSync(fd, content, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, target);
      renamed = true;
      const dirFd = openSync(hostDir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      if (!renamed) {
        try {
          rmSync(tmpPath, { force: true });
        } catch {
          // 尽力清理：清理失败以原始发布错误为准。
        }
      }
      throw ioFailure('atomic_publish_failed', relativePath, error);
    }
  }

  return {
    canonicalRoot,
    dataRootIdentity,

    ensureHostDir(): void {
      const stats = lstatOrNull(hostDir);
      if (stats === null) {
        try {
          mkdirSync(hostDir, { mode: HOST_DIR_MODE });
        } catch (error) {
          // Concurrent lock candidates may create the same parent. Re-validate below;
          // EEXIST is not permission to trust a directory/symlink made by another actor.
          if (fsCode(error) !== 'EEXIST') {
            throw ioFailure('host_dir_create_failed', HOST_DIR_RELATIVE_PATH, error);
          }
        }
      }
      const after = lstatOrNull(hostDir);
      if (after === null) {
        throw ioFailure('host_dir_create_failed', HOST_DIR_RELATIVE_PATH, new Error('mkdir 后目录不存在'));
      }
      assertProtectedHostDir(after);
    },

    issueAuthToken(): string {
      const token = randomBytes(32).toString('hex');
      atomicPublishFile(AUTH_TOKEN_FILE_NAME, AUTH_TOKEN_RELATIVE_PATH, token);
      return token;
    },

    readTrustedAuthToken(): string {
      verifyHostDirForRead();
      const stats = lstatOrNull(authTokenPath);
      if (stats === null) {
        // 发现与凭据同时缺失＝没有可核验实例（host_not_found）；发现存在而凭据
        // 缺失＝状态不一致（invalid_discovery），两者不得混为一谈（§14）。
        if (lstatOrNull(discoveryPath) === null) {
          throw new HostProtocolError('host_not_found', OPERATION, '未发现运行中的 Host（缺少发现与凭据）', {
            details: { relativePath: AUTH_TOKEN_RELATIVE_PATH, reason: 'discovery_and_token_absent' },
          });
        }
        throw invalidDiscovery('auth_token_absent', AUTH_TOKEN_RELATIVE_PATH);
      }
      assertProtectedFile(stats, AUTH_TOKEN_RELATIVE_PATH);
      const token = readFileSync(authTokenPath, 'utf8');
      if (!isSha256Hex(token)) {
        // 不回显文件内容（可能是凭据材料）。
        throw invalidDiscovery('auth_token_malformed', AUTH_TOKEN_RELATIVE_PATH);
      }
      return token;
    },

    publishDiscovery(record: HostDiscoveryRecord): void {
      // 入参跨了信任边界即按未知值重新校验：唯一允许形态（§5.1），未知字段、
      // 非回环地址、任意 URL/根外凭据路径字段均被结构校验拒绝。
      const validated = validateDiscoveryRecord(record);
      assertDiscoveryForLocalRoot(validated, dataRootIdentity);
      atomicPublishFile(DISCOVERY_FILE_NAME, DISCOVERY_RELATIVE_PATH, JSON.stringify(validated));
    },

    readTrustedDiscovery(): HostDiscoveryRecord {
      verifyHostDirForRead();
      const stats = lstatOrNull(discoveryPath);
      if (stats === null) {
        throw new HostProtocolError('host_not_found', OPERATION, '未发现运行中的 Host（缺少发现文件）', {
          details: { relativePath: DISCOVERY_RELATIVE_PATH, reason: 'discovery_absent' },
        });
      }
      assertProtectedFile(stats, DISCOVERY_RELATIVE_PATH);
      const record = parseDiscoveryText(readFileSync(discoveryPath, 'utf8'));
      assertDiscoveryForLocalRoot(record, dataRootIdentity);
      return record;
    },

    cleanupInstanceFiles(expectedInstanceId: string): HostCleanupResult {
      if (!isUuidV4(expectedInstanceId)) {
        throw new HostProtocolError('invalid_input', OPERATION, 'expectedInstanceId 必须是规范 UUID v4', {
          details: { field: 'expectedInstanceId', reason: 'invalid_uuid_v4' },
        });
      }
      const skip = (outcome: HostCleanupOutcome): HostCleanupResult => ({
        outcome,
        deletedDiscovery: false,
        deletedAuthToken: false,
      });

      const hostDirStats = lstatOrNull(hostDir);
      if (hostDirStats === null) {
        return skip('skipped_host_dir_absent');
      }
      // host/ 不可信（如指向根外的符号链接）：绝不跟随、不在其中删除任何文件。
      if (hostDirStats.isSymbolicLink() || !hostDirStats.isDirectory()) {
        return skip('skipped_host_dir_unsafe');
      }
      if (realpathSync(hostDir) !== hostDir) {
        return skip('skipped_host_dir_unsafe');
      }

      const discoveryStats = lstatOrNull(discoveryPath);
      if (discoveryStats === null) {
        return skip('skipped_discovery_absent');
      }
      if (discoveryStats.isSymbolicLink() || !discoveryStats.isFile()) {
        return skip('skipped_discovery_unsafe');
      }

      let record: HostDiscoveryRecord;
      try {
        record = parseDiscoveryText(readFileSync(discoveryPath, 'utf8'));
      } catch (error) {
        if (error instanceof HostProtocolError) {
          return skip('skipped_discovery_invalid');
        }
        throw error;
      }
      // 按实例清理的第二道防线（第一道是调用方持锁）：旧实例的迟到清理回调
      // 核对不一致必须放弃删除，不能删除新实例的发现或凭据。
      if (record.hostInstanceId !== expectedInstanceId) {
        return skip('skipped_instance_mismatch');
      }

      const tokenStats = lstatOrNull(authTokenPath);
      if (tokenStats !== null && !tokenStats.isFile() && !tokenStats.isSymbolicLink()) {
        return skip('skipped_token_unsafe');
      }

      try {
        unlinkSync(discoveryPath);
        if (tokenStats !== null) {
          unlinkSync(authTokenPath);
        }
      } catch (error) {
        // §10.5：删除失败不删锁、不伪装成功，按未确认处理（抛给调用方）。
        throw ioFailure('cleanup_failed', DISCOVERY_RELATIVE_PATH, error);
      }
      // writer.lock 永不被业务清理删除、移动或替换（§3.3/§10.5 第 7 步）；
      // 发现/凭据的失效判定不依赖 PID（§4.1）。
      return { outcome: 'cleaned', deletedDiscovery: true, deletedAuthToken: tokenStats !== null };
    },
  };
}

/** 供 F-004 锁实现定位锁目标文件；本模块永不删除该文件。 */
export function writerLockPathOf(canonicalRoot: string): string {
  return join(canonicalRoot, HOST_DIR_NAME, WRITER_LOCK_FILE_NAME);
}
