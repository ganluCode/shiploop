/**
 * F-003 规范数据根解析（§3.1/§3.2）。
 *
 * 职责：把「候选数据根」固定为规范根（realpath 的原样返回字符串）并计算
 * dataRootIdentity（复用 F-002 契约模块的唯一实现 computeDataRootIdentity）。
 *
 * 根来源二选一：
 * - dataRoot：显式绝对路径（CLI --data-root）；
 * - defaultDataRoot：调用方按 P01 规则（shiploop-core ports 的
 *   deriveDefaultDataRoot）预先推导的默认根字符串。本模块不重新实现该推导、
 *   也不读取进程真实用户目录——默认根的生产注入由 F-006 启动入口完成
 *   （F-006 才声明 shiploop-core 依赖并装配 openCoreApplication）。
 *
 * 行为：
 * - createIfMissing=true（仅 host start）：沿用 openCoreApplication 语义，只创建
 *   根目录本身（recursive，mode 0700）；=false（status/stop）时根缺失即
 *   host_not_found，不创建任何目录；
 * - 同一真实根的别名（如 macOS /var 与 /private/var）realpath 后得到同一规范根与
 *   同一身份；不同真实根身份不同；
 * - 错误消息与 details 不含绝对路径（§7.3 脱敏）。
 */
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { computeDataRootIdentity, HostProtocolError } from '../contract/index.js';

const OPERATION = 'host.discovery';

export interface CanonicalDataRootOptions {
  /** 显式数据根（POSIX 绝对路径）。 */
  readonly dataRoot?: string;
  /** 由调用方按 P01 deriveDefaultDataRoot 推导的默认根（POSIX 绝对路径）。 */
  readonly defaultDataRoot?: string;
  /** 仅 host start 允许为 true：创建缺失的根目录本身（0700）。 */
  readonly createIfMissing?: boolean;
}

export interface CanonicalDataRoot {
  /** realpath 原样返回的规范根字符串。 */
  readonly canonicalRoot: string;
  /** §3.2 数据根身份（64 位小写 hex）。 */
  readonly dataRootIdentity: string;
}

function invalidInput(message: string, details: Record<string, unknown>): HostProtocolError {
  return new HostProtocolError('invalid_input', OPERATION, message, { details });
}

/** 候选根的形态校验（绝对、无 NUL、非文件系统根）；不触碰文件系统。 */
function validateCandidate(candidate: unknown, field: 'dataRoot' | 'defaultDataRoot'): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw invalidInput('数据根必须是非空字符串', { field, reason: 'invalid_root_type' });
  }
  if (candidate.includes('\0')) {
    throw invalidInput('数据根不允许包含 NUL 字节', { field, reason: 'nul_byte' });
  }
  if (!isAbsolute(candidate)) {
    throw invalidInput('数据根必须是 POSIX 绝对路径', { field, reason: 'not_absolute' });
  }
  if (candidate.replaceAll(/\/+$/g, '').length === 0) {
    throw invalidInput('数据根不允许是文件系统根', { field, reason: 'filesystem_root' });
  }
  return candidate;
}

/**
 * 解析规范数据根：形态校验 →（可选）创建根目录本身 → 存在性与目录核验 →
 * realpath 固定 → 计算身份。任何一步失败都不留下半成品目录之外的状态，
 * 且绝不返回未经 realpath 固定的路径。
 */
export function resolveCanonicalDataRoot(options: CanonicalDataRootOptions): CanonicalDataRoot {
  const hasExplicit = options?.dataRoot !== undefined;
  const hasDefault = options?.defaultDataRoot !== undefined;
  if (hasExplicit === hasDefault) {
    throw invalidInput('必须且只能提供 dataRoot 或 defaultDataRoot 之一', {
      reason: 'root_source_ambiguous',
    });
  }
  const field = hasExplicit ? 'dataRoot' : 'defaultDataRoot';
  const candidate = validateCandidate(hasExplicit ? options.dataRoot : options.defaultDataRoot, field);
  const createIfMissing = options.createIfMissing === true;

  if (!existsSync(candidate)) {
    if (!createIfMissing) {
      throw new HostProtocolError('host_not_found', OPERATION, '数据根不存在且本次操作不允许创建', {
        details: { reason: 'data_root_absent' },
      });
    }
    try {
      // 与 openCoreApplication 一致：只创建根目录本身，mode 0700。
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new HostProtocolError('internal', OPERATION, '无法创建数据根目录', {
        details: { reason: 'data_root_create_failed', fsCode: (error as NodeJS.ErrnoException)?.code ?? 'unknown' },
        cause: error,
      });
    }
  }
  let stats;
  try {
    stats = statSync(candidate);
  } catch (error) {
    throw new HostProtocolError('internal', OPERATION, '无法核验数据根', {
      details: { reason: 'data_root_stat_failed', fsCode: (error as NodeJS.ErrnoException)?.code ?? 'unknown' },
      cause: error,
    });
  }
  if (!stats.isDirectory()) {
    throw invalidInput('数据根必须是目录（拒绝把普通文件当数据根）', {
      field,
      reason: 'not_a_directory',
    });
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(candidate);
  } catch (error) {
    throw new HostProtocolError('internal', OPERATION, '无法解析数据根真实路径', {
      details: { reason: 'data_root_realpath_failed', fsCode: (error as NodeJS.ErrnoException)?.code ?? 'unknown' },
      cause: error,
    });
  }
  return { canonicalRoot, dataRootIdentity: computeDataRootIdentity(canonicalRoot) };
}
