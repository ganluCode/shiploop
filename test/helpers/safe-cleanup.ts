/**
 * P01-4 / F-002 安全清理守卫（仅测试使用）。
 *
 * 目标：验收夹具只删除**本次运行持有且位于临时授权根内**的资源，绝不触碰受测仓库、
 * 用户真实目录或其他未知位置；发现符号链接逃逸时拒绝清理而不是跟随链接。
 *
 * 规则（fail-closed，违规即抛 SafeCleanupError，不静默继续）：
 * - 目标必须存在且 realpath 后位于授权临时根之内（`not_authorized`）；
 * - 目标不得是受保护路径、也不得包含受保护路径（`protected`）——避免误删用户仓库；
 * - 目标树内任何符号链接的 realpath 落在授权根之外即判逃逸（`symlink_escape`），
 *   拒绝继续；节点自身不会被跟随（rmSync 只删除链接本身）；
 * - 删除后核验目标确实消失（`still_exists`）。
 */
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export type SafeCleanupErrorKind =
  | 'not_authorized'
  | 'protected'
  | 'symlink_escape'
  | 'not_a_directory'
  | 'still_exists';

export class SafeCleanupError extends Error {
  readonly kind: SafeCleanupErrorKind;
  readonly target: string;
  readonly detail?: string;

  constructor(kind: SafeCleanupErrorKind, target: string, message: string, detail?: string) {
    super(message);
    this.name = 'SafeCleanupError';
    this.kind = kind;
    this.target = target;
    this.detail = detail;
  }
}

export function isInsideDirectory(candidate: string, directory: string): boolean {
  const base = resolve(directory);
  const target = resolve(candidate);
  if (target === base) {
    return true;
  }
  return target.startsWith(base + sep);
}

export interface SafeRemoveOptions {
  /** 授权临时根（realpath 后作为清理授权边界）。 */
  readonly authorizedRoot: string;
  /** 受保护路径（受测仓库、用户 HOME 等）；不提供时仅保留系统约束。 */
  readonly protectedPaths?: readonly string[];
}

/**
 * 递归检查目标树：任何符号链接若解析到授权根之外即判逃逸。
 * 不跟随链接递归（避免环与越界读取）。
 */
export function assertNoSymlinkEscape(target: string, authorizedRoot: string): void {
  const realAuth = realpathSync(authorizedRoot);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = realpathSync(child);
        if (!isInsideDirectory(resolved, realAuth)) {
          throw new SafeCleanupError(
            'symlink_escape',
            target,
            `临时根内符号链接逃逸出授权根：${child} -> ${resolved}`,
            resolved,
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(child);
      }
    }
  };
  walk(target);
}

/** 校验目标可安全删除；违规抛 SafeCleanupError。 */
export function assertSafeToRemove(target: string, options: SafeRemoveOptions): void {
  const candidate = resolve(target);
  if (!existsSync(candidate)) {
    return;
  }
  const stat = lstatSync(candidate);
  if (!stat.isDirectory()) {
    throw new SafeCleanupError('not_a_directory', candidate, `清理目标不是目录：${candidate}`);
  }
  const realTarget = realpathSync(candidate);
  const realAuthorized = realpathSync(options.authorizedRoot);
  if (!isInsideDirectory(realTarget, realAuthorized)) {
    throw new SafeCleanupError(
      'not_authorized',
      candidate,
      `清理目标不在授权临时根 ${realAuthorized} 之内：${realTarget}`,
    );
  }
  for (const protectedPath of options.protectedPaths ?? []) {
    if (!existsSync(protectedPath)) {
      continue;
    }
    const realProtected = realpathSync(protectedPath);
    if (
      realTarget === realProtected ||
      isInsideDirectory(realTarget, realProtected) ||
      isInsideDirectory(realProtected, realTarget)
    ) {
      throw new SafeCleanupError(
        'protected',
        candidate,
        `清理目标与受保护路径重叠（拒绝误删用户仓库）：${realTarget} vs ${realProtected}`,
        realProtected,
      );
    }
  }
  // 授权边界必须真实存在且为目录（防御纵深）。
  if (!statSync(options.authorizedRoot).isDirectory()) {
    throw new SafeCleanupError(
      'not_authorized',
      candidate,
      `授权临时根不是目录：${options.authorizedRoot}`,
    );
  }
  assertNoSymlinkEscape(realTarget, realAuthorized);
}

/**
 * 安全删除临时根：校验通过后递归删除并核验确实消失。
 * 目标不存在视为已清理（幂等，直接返回）。
 */
export function safeRemoveTempRoot(target: string, options: SafeRemoveOptions): void {
  const candidate = resolve(target);
  if (!existsSync(candidate)) {
    return;
  }
  assertSafeToRemove(candidate, options);
  rmSync(candidate, { recursive: true, force: true });
  if (existsSync(candidate)) {
    throw new SafeCleanupError('still_exists', candidate, `清理后目标仍然存在：${candidate}`);
  }
}
