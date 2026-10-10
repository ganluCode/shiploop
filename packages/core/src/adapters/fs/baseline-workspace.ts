/**
 * F-008（P02-3）基线工作区读取 fs 适配器（adapters 层）：§6.3 工作区确定性
 * 摘要采集与 cwd realpath 核验的窄端口实现。
 *
 * 契约依据：docs/p02-3-onboarding-contract.md §6.1（cwdRef 仓库内相对子目录；
 * 越界/符号链接逃逸 → invalid_input path_outside_repository）、§6.3
 * （workingTreeDigest 覆盖 tracked+untracked 源文件与必要配置，冻结排除表，
 * 算法纯函数见 ports/baseline.ts）、§6.4（不解析任何环境值）。
 *
 * 不变量：
 * - 只读：不执行脚本、不安装依赖、不写任何文件、不 git add/commit/stash；
 * - 目录遍历不跟随符号链接（DirectoryEntry.isSymbolicLink 一律跳过：防逃逸、
 *   防挂载点不确定；排除表按目录名在任意层级生效）；文件内容仅进入 SHA-256，
 *   不进入返回面；路径分隔统一 POSIX 相对形态；
 * - resolveContainedCwd 对根与目标都做 realpath：目标不存在/非目录 → missing
 *   （由应用层按 invalid_check_plan 拒绝）；realpath 落在根外 → outside
 *   （应用层按 path_outside_repository 拒绝）；根自身必须可 realpath；
 * - import 本模块无副作用；读取错误原样抛出（由应用层映射为受控公开错误）。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  BASELINE_WORKSPACE_EXCLUDED_DIR_NAMES,
  computeBaselineWorkingTreeDigest,
  type BaselineCwdResolution,
  type BaselineWorkspaceFileEntry,
  type BaselineWorkspaceReader,
  type BaselineWorkspaceSummary,
} from '../../ports/baseline.js';

const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set<string>(BASELINE_WORKSPACE_EXCLUDED_DIR_NAMES);

export interface BaselineWorkspaceReaderOptions {
  /**
   * 采集的受管文件数上限（防御纵深：拒绝无界遍历；正常仓库远低于上限）。
   * 超限时抛错（由应用层折算 invalid_input），不静默截断（截断会假装摘要完整）。
   */
  readonly maxFileCount?: number;
}

export function createBaselineWorkspaceReader(
  options: BaselineWorkspaceReaderOptions = {},
): BaselineWorkspaceReader {
  const maxFileCount = options.maxFileCount ?? 200_000;

  function collectEntries(root: string): BaselineWorkspaceFileEntry[] {
    const entries: BaselineWorkspaceFileEntry[] = [];

    function walk(directory: string, prefix: string): void {
      const children = readdirSync(directory, { withFileTypes: true });
      // 确定性：目录项按名字排序后遍历（最终摘要仍以排序键计算，双保险）。
      children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const child of children) {
        if (child.isDirectory()) {
          if (EXCLUDED_DIR_NAMES.has(child.name)) {
            continue;
          }
          walk(join(directory, child.name), prefix.length === 0 ? child.name : `${prefix}/${child.name}`);
          continue;
        }
        // 符号链接与其他特殊条目一律跳过（不跟随、不摘要）。
        if (!child.isFile()) {
          continue;
        }
        if (entries.length >= maxFileCount) {
          throw new Error(
            `baseline workspace reader: 受管文件数超过上限 ${maxFileCount}（拒绝无界摘要，不静默截断）`,
          );
        }
        const relativePath = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
        const content = readFileSync(join(directory, child.name));
        entries.push({
          path: relativePath,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
      }
    }

    walk(root, '');
    return entries;
  }

  function resolveTarget(
    canonicalRepositoryRoot: string,
    cwdRef: string | null,
    relativeTarget: string | null,
  ): { status: 'inside'; canonicalPath: string } | { status: 'missing' } | { status: 'outside' } {
    const root = realpathSync(canonicalRepositoryRoot);
    const segments = [...(cwdRef === null ? [] : cwdRef.split('/')), ...(relativeTarget === null ? [] : relativeTarget.split('/'))];
    const target = join(root, ...segments);
    let canonical: string;
    try {
      canonical = realpathSync(target);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
        return { status: 'missing' };
      }
      throw error;
    }
    if (canonical === root || canonical.startsWith(`${root}${sep}`)) {
      return { status: 'inside', canonicalPath: canonical };
    }
    return { status: 'outside' };
  }

  return {
    async readWorkspaceSummary(canonicalRepositoryRoot: string): Promise<BaselineWorkspaceSummary> {
      const root = realpathSync(canonicalRepositoryRoot);
      const { digest, fileCount } = computeBaselineWorkingTreeDigest(collectEntries(root));
      return {
        digest,
        fileCount,
        excludedDirNames: [...BASELINE_WORKSPACE_EXCLUDED_DIR_NAMES],
      };
    },

    async resolveContainedCwd(
      canonicalRepositoryRoot: string,
      cwdRef: string | null,
    ): Promise<BaselineCwdResolution> {
      const resolved = resolveTarget(canonicalRepositoryRoot, cwdRef, null);
      if (resolved.status !== 'inside') {
        return resolved;
      }
      if (!statSync(resolved.canonicalPath).isDirectory()) {
        return { status: 'missing' };
      }
      return { status: 'inside', canonicalPath: resolved.canonicalPath };
    },

    async probeRelativeTarget(
      canonicalRepositoryRoot: string,
      cwdRef: string | null,
      relativeTarget: string,
    ): Promise<'exists' | 'missing' | 'outside'> {
      // 存在性探测：目标既可以是文件也可以是目录（argv0 可能指向任一形态）。
      const resolved = resolveTarget(canonicalRepositoryRoot, cwdRef, relativeTarget);
      return resolved.status === 'inside' ? 'exists' : resolved.status;
    },
  };
}
