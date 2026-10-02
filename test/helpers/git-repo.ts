/**
 * P01-3 / F-004 真实 Git 仓库夹具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 保证：
 * - 通过 execFileSync 以独立 argv 调用真实 git（不拼接 shell），环境最小且确定
 *   （GIT_CONFIG_NOSYSTEM/GLOBAL/SYSTEM 隔离机器配置、LC_ALL=C），测试结果不依赖
 *   开发机的全局 git 配置或默认分支设置；
 * - git 不可用时 assertGitAvailable 直接抛错：必需驱动缺失时测试失败而非 skip
 *   （与 F-013「必需驱动/Git/检查缺失时失败而非 skip」一致）；
 * - commit 经 -c 注入一次性身份与禁用签名，不读取也不修改任何真实用户配置；
 * - 所有仓库目录由调用方在临时沙箱（helpers/temp-sandbox.ts）内提供，本文件不
 *   接触真实用户目录、凭据或网络（clone 仅允许本地路径来源）。
 */
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { mkdirSync } from 'node:fs';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** 最小确定的 git 子进程环境：隔离机器级配置，禁止任何交互提示。 */
export function gitTestEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

/** 以独立 argv 执行真实 git 并返回 stdout；失败抛错（测试失败而非 skip）。 */
export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    env: gitTestEnv(),
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
  }) as string;
}

/** 必需驱动核验：git 不可用即失败（不 skip）。返回 `git --version` 输出供证据记录。 */
export function assertGitAvailable(): string {
  return git(['--version'], process.cwd()).trim();
}

/** 在指定目录初始化真实仓库（默认分支固定为 main，保证机器间确定）。 */
export function initGitRepo(dir: string, options: { readonly bare?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  if (options.bare === true) {
    git(['init', '--bare', '--initial-branch=main', dir], process.cwd());
    return;
  }
  git(['init', '--initial-branch=main', dir], process.cwd());
}

/** 暂存全部变更并以一次性注入身份提交；返回提交后的 HEAD。 */
export function commitAll(dir: string, message: string): string {
  git(['add', '-A'], dir);
  git(
    [
      '-c',
      'user.name=ShipLoop Test',
      '-c',
      'user.email=shiploop-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    dir,
  );
  return git(['rev-parse', 'HEAD'], dir).trim();
}
