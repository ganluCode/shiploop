/**
 * P03-2 / F-004 受控源文件读取适配器（adapters 层）：获准根白名单内
 * realpath/no-follow 常规文件读取的真实文件系统实现
 * （ports/execution-input.ts 契约）。
 *
 * 设计依据：core-design/03 §4（路径通过 ID 和授权根计算，检查 realpath、
 * 符号链接、目录穿越；不拼接不可信标题）与 core-design/06（必需输入快照
 * 来自获准来源，可变化路径不当快照）。
 *
 * 不变量：
 * - 获准根白名单由可信装配显式注入（rootId → 绝对路径）；构造时逐个
 *   realpath 固定并核验为已存在真实目录，缺失/非目录/相对根 fail-closed
 *   （invalid_input）；空白名单 = 任何根都是未获准引用（unknown_root）；
 * - 目标只由「已 realpath 的获准根 + POSIX 相对路径」推导；三层防线与
 *   F-010 制品文件适配器一致：
 *   1. 输入校验（locator 契约使 .. / 绝对路径 / 反斜杠无法进入推导）；
 *   2. 目标 realpath 必须位于获准根之内（符号链接祖先逃逸在任何读取
 *      之前拒绝）；
 *   3. lstat 目标叶（符号链接一律拒绝、非常规文件拒绝）+ O_NOFOLLOW
 *      打开 + fstat 复核常规文件（检查与打开之间的链接替换被 O_NOFOLLOW
 *      拦截）；
 * - 只读：不创建/修改/删除任何文件或目录，不执行脚本；错误脱敏——
 *   InputSourceError 的消息与 details 只含获准根内相对位置与脱敏错误码，
 *   不含绝对路径或正文内容；输入校验失败抛 StorageError(kind='validation')；
 * - 可信项目模式边界：检查（realpath/lstat）与操作（open）之间的并发替换
 *   窗口由「单 Host 写入者 + 用户明确授权的可信项目」前提收窄，本适配器
 *   不宣称强 OS 沙箱；
 * - import 本模块无副作用；createInputSourceFileReader 只做根核验
 *   （realpath/lstat），不创建任何目录或文件。
 *
 * 本模块不实现：采集编排与制品发布（application/execution-input.ts）、
 * 制品文件 staging/发布（F-010/F-011）、Host/CLI 命令。
 */
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { InputSourceError, validateInputSourceReadRequest } from '../../ports/execution-input.js';
import type {
  InputSourceContent,
  InputSourceFileReader,
} from '../../ports/execution-input.js';
import { isPlainObject, requireSafeRecordKey, validationError } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';

const OPERATION = 'InputSourceFileReader';

export interface InputSourceFileReaderOptions {
  /**
   * 获准根白名单：rootId → 授权根绝对路径（可信装配注入）。
   * 构造时逐个 realpath 固定；空白名单 fail-closed（任何根引用都是
   * 未获准引用）。
   */
  readonly roots: Readonly<Record<string, string>>;
}

type NodeError = NodeJS.ErrnoException;

function errorCode(error: unknown): string | undefined {
  return (error as NodeError | null)?.code;
}

/** 运行期文件条件统一映射；消息/details 只含相对位置与错误码（脱敏）。 */
function mapFsError(error: unknown, operation: string, relativePath: string): InputSourceError {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new InputSourceError('not_found', operation, `${operation}: 位置不存在`, {
      details: { relativePath, code },
      cause: error,
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new InputSourceError('permission', operation, `${operation}: 权限拒绝`, {
      details: { relativePath, code },
      cause: error,
    });
  }
  if (code === 'ELOOP') {
    return new InputSourceError('escape', operation, `${operation}: 检测到符号链接（no-follow 拒绝）`, {
      details: { relativePath, code, reason: 'symlink_no_follow' },
      cause: error,
    });
  }
  return new InputSourceError('io', operation, `${operation}: 文件操作失败（${code ?? 'unknown'}）`, {
    details: { relativePath, code: code ?? 'unknown' },
    cause: error,
  });
}

/**
 * 装配受控源文件读取端口。只做获准根核验（realpath/lstat），不创建任何
 * 目录或文件；import 本模块无副作用。
 */
export function createInputSourceFileReader(
  options: InputSourceFileReaderOptions,
): InputSourceFileReader {
  const operation = `${OPERATION}.create`;
  const context: ValidationContext = { operation };
  if (options === null || typeof options !== 'object' || !isPlainObject(options.roots)) {
    throw new InputSourceError('invalid_input', operation, `${operation}: 必须提供获准根白名单 roots`, {
      details: { reason: 'roots_missing' },
    });
  }
  const canonicalRoots = new Map<string, string>();
  for (const [rootId, rootPath] of Object.entries(options.roots)) {
    try {
      requireSafeRecordKey(rootId, context, `roots.${rootId}`);
    } catch (error) {
      throw new InputSourceError('invalid_input', operation, `${operation}: 获准根 ID 非法`, {
        details: { reason: 'root_id_invalid' },
        cause: error,
      });
    }
    if (typeof rootPath !== 'string' || rootPath.length === 0 || !isAbsolute(rootPath)) {
      throw new InputSourceError('invalid_input', operation, `${operation}: 获准根必须是绝对路径`, {
        details: { reason: 'root_not_absolute', root: rootId },
      });
    }
    let real: string;
    try {
      real = realpathSync(rootPath);
    } catch (error) {
      throw new InputSourceError('invalid_input', operation, `${operation}: 获准根不存在或不可解析`, {
        details: { reason: 'root_not_found', root: rootId, code: errorCode(error) ?? 'unknown' },
        cause: error,
      });
    }
    let stat;
    try {
      stat = lstatSync(real);
    } catch (error) {
      throw new InputSourceError('invalid_input', operation, `${operation}: 获准根不可 stat`, {
        details: { reason: 'root_stat_failed', root: rootId, code: errorCode(error) ?? 'unknown' },
        cause: error,
      });
    }
    if (!stat.isDirectory()) {
      throw new InputSourceError('invalid_input', operation, `${operation}: 获准根必须是目录`, {
        details: { reason: 'root_not_directory', root: rootId },
      });
    }
    canonicalRoots.set(rootId, real);
  }

  return {
    async openSourceRead(request: unknown): Promise<InputSourceContent> {
      const op = `${OPERATION}.openSourceRead`;
      const valid = validateInputSourceReadRequest(request, op);
      const rootReal = canonicalRoots.get(valid.root);
      if (rootReal === undefined) {
        throw new InputSourceError('unknown_root', op, `${op}: 根 ID 不在获准白名单内，拒绝解析`, {
          details: { relativePath: valid.relativePath, reason: 'unknown_root', root: valid.root },
        });
      }
      // 词法防线：推导位置必须位于获准根内（输入校验已使越界不可能，防御纵深）。
      const abs = join(rootReal, ...valid.relativePath.split('/'));
      if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
        throw new InputSourceError('escape', op, `${op}: 推导位置越出获准根`, {
          details: { relativePath: valid.relativePath, reason: 'derived_path_outside_root' },
        });
      }
      // lstat 目标叶：符号链接一律拒绝；非常规文件拒绝；缺失 not_found。
      let leafStat;
      try {
        leafStat = lstatSync(abs);
      } catch (error) {
        throw mapFsError(error, op, valid.relativePath);
      }
      if (leafStat.isSymbolicLink()) {
        throw new InputSourceError('escape', op, `${op}: 目标是符号链接，拒绝不可信链接`, {
          details: { relativePath: valid.relativePath, reason: 'untrusted_symlink' },
        });
      }
      if (!leafStat.isFile()) {
        throw new InputSourceError('not_regular_file', op, `${op}: 目标不是常规文件`, {
          details: { relativePath: valid.relativePath, reason: 'not_a_regular_file' },
        });
      }
      // 真实位置防线：realpath 必须仍在获准根内（符号链接祖先逃逸在此拦截）。
      let real: string;
      try {
        real = realpathSync(abs);
      } catch (error) {
        throw mapFsError(error, op, valid.relativePath);
      }
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        throw new InputSourceError('escape', op, `${op}: 目标真实位置越出获准根（符号链接逃逸）`, {
          details: { relativePath: valid.relativePath, reason: 'target_realpath_outside_root' },
        });
      }
      // no-follow 打开 + fstat 复核：检查与打开之间的链接替换被 O_NOFOLLOW 拦截。
      let fd: number;
      try {
        const noFollow = constants.O_NOFOLLOW ?? 0;
        fd = openSync(abs, constants.O_RDONLY | noFollow);
      } catch (error) {
        throw mapFsError(error, op, valid.relativePath);
      }
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile()) {
          throw new InputSourceError('not_regular_file', op, `${op}: 目标不是常规文件`, {
            details: { relativePath: valid.relativePath, reason: 'not_a_regular_file' },
          });
        }
        const stream = createReadStream(valid.relativePath, { fd, autoClose: true });
        return { relativePath: valid.relativePath, sizeBytes: opened.size, stream };
      } catch (error) {
        try {
          closeSync(fd);
        } catch {
          // 关闭失败的诊断不覆盖原始错误。
        }
        if (error instanceof InputSourceError) {
          throw error;
        }
        throw mapFsError(error, op, valid.relativePath);
      }
    },
  };
}
