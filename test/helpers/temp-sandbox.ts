/**
 * F-003 临时资源夹具：在系统临时目录下创建彼此独立、互不复用的沙箱目录。
 *
 * 保证：
 * - 每次调用都经 mkdtemp 得到全新目录，重复运行不依赖上一次生成的文件；
 * - 沙箱位于 os.tmpdir() 下，且显式拒绝落在受测仓库或用户数据根之内；
 * - cleanup() 递归强制删除并核验目录确实消失；
 * - withTempSandbox 通过 try/finally 保证回调抛出时资源同样被清理。
 *
 * 本文件不是测试用例（文件名不匹配 *.test.*，且被 vitest 配置 exclude），
 * 只提供确定性夹具能力；不接触凭据、全局 Pi 配置或真实模型。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type TempSandboxOptions = {
  /** 沙箱不允许落在这些目录之内（如受测仓库根、用户 HOME）。 */
  outside?: readonly string[];
};

export type TempSandbox = {
  /** 已创建的临时目录绝对路径。 */
  readonly path: string;
  /** 删除沙箱；若目录仍然存在则抛出（fail-closed，不静默成功）。 */
  cleanup(): void;
};

function isInside(candidate: string, directory: string): boolean {
  const base = resolve(directory);
  const target = resolve(candidate);
  return target === base || target.startsWith(base + sep);
}

export function createTempSandbox(prefix = 'shiploop-test-', options: TempSandboxOptions = {}): TempSandbox {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const realTmp = resolve(tmpdir());
  if (!isInside(path, realTmp)) {
    rmSync(path, { recursive: true, force: true });
    throw new Error(`临时沙箱 ${path} 不在系统临时目录 ${realTmp} 之内`);
  }
  for (const protectedRoot of options.outside ?? []) {
    if (isInside(path, protectedRoot)) {
      rmSync(path, { recursive: true, force: true });
      throw new Error(`临时沙箱 ${path} 不允许位于受保护目录 ${resolve(protectedRoot)} 之内`);
    }
  }
  if (isInside(path, homedir()) && resolve(homedir()) !== realTmp) {
    rmSync(path, { recursive: true, force: true });
    throw new Error(`临时沙箱 ${path} 不允许位于用户 HOME ${homedir()} 之内`);
  }

  let cleaned = false;
  return {
    path,
    cleanup(): void {
      if (cleaned) {
        return;
      }
      rmSync(path, { recursive: true, force: true });
      cleaned = true;
      if (existsSync(path)) {
        throw new Error(`临时沙箱清理失败，目录仍然存在：${path}`);
      }
    },
  };
}

/**
 * 在全新临时沙箱中执行回调；无论正常结束还是抛出异常都清理资源。
 * 回调抛出的原始错误会在清理完成后继续向上抛出。
 */
export function withTempSandbox<T>(
  fn: (root: string) => T,
  options: TempSandboxOptions & { prefix?: string } = {},
): T {
  const sandbox = createTempSandbox(options.prefix ?? 'shiploop-test-', { outside: options.outside });
  try {
    return fn(sandbox.path);
  } finally {
    sandbox.cleanup();
  }
}
