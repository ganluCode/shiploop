/**
 * F-003 P02-3 仓库变体夹具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 在临时沙箱内准备基线静态接入所需的真实 Git 仓库变体（全部由真实 git 进程创建）：
 * - withHead：干净、有初始 commit 的受支持仓库；
 * - noInitialCommit：仅 `git init`、无任何 commit（headCommit=null，不猜 main）；
 * - dirty：有 HEAD，且同时含已跟踪文件改动与未跟踪新文件（脏工作区原样保留）；
 * - originSeed/cloneA/cloneB：同一本地 bare remote 的两个 clone（同 remote、不同本地身份）；
 * - alias：指向 withHead 的符号链接别名（规范路径应解析为同一仓库）；
 * - malicious：含「恶意初始化脚本」的仓库——脚本行为被限制为只写一个仓库内哨兵文件，
 *   用于断言静态 inspect 绝不执行仓库脚本（哨兵不存在即未执行）。
 *
 * 安全约束（复用既有夹具积木，不另立一套）：
 * - 复用 helpers/git-repo：独立 argv 调用真实 git、隔离机器/用户配置（GIT_CONFIG_*=/dev/null）、
 *   一次性注入提交身份、可注入隔离 HOME；git 缺失显式失败不 skip；
 * - 复用 helpers/temp-sandbox 与 helpers/safe-cleanup：只删除本次持有的临时根（自建沙箱时），
 *   或经授权根校验后删除本次自建的 repos 子目录（复用外部沙箱时）；绝不触碰开发仓库或用户 HOME；
 * - 不读真实凭据、不联网（clone 只从本地路径来源）、不调用模型。
 */
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGitAvailable, commitAll, git, initGitRepo } from '../git-repo.ts';
import { safeRemoveTempRoot } from '../safe-cleanup.ts';
import { createTempSandbox } from '../temp-sandbox.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 仓库变体目录名（含 Unicode/空格，顺带覆盖路径解析）。 */
const REPO_DIRS = {
  withHead: '仓库 with-head',
  noInitialCommit: '仓库 no-initial-commit',
  dirty: '仓库 dirty',
  origin: 'origin.git',
  originSeed: '仓库 origin-seed',
  cloneA: '仓库 clone-a',
  cloneB: '仓库 clone-b',
  alias: '仓库 alias',
  malicious: '仓库 malicious',
} as const;

export interface CreateRepoVariantsOptions {
  /** 已存在的沙箱根（复用 Host/CLI 夹具）；不提供时自建临时沙箱并负责删除。 */
  readonly root?: string;
  /** git 子进程使用的隔离 HOME（不提供时在沙箱根下创建）。 */
  readonly homeDir?: string;
  readonly prefix?: string;
}

export interface RepoVariants {
  readonly root: string;
  readonly homeDir: string;
  /** 自建沙箱时为 true：dispose 删除整个沙箱；复用外部沙箱时为 false。 */
  readonly ownsSandbox: boolean;
  readonly withHead: string;
  readonly noInitialCommit: string;
  readonly dirty: string;
  readonly dirtyTrackedFile: string;
  readonly dirtyUntrackedFile: string;
  readonly origin: string;
  readonly cloneA: string;
  readonly cloneB: string;
  readonly alias: string;
  readonly malicious: string;
  /** 恶意初始化脚本的仓库内路径（若被运行会写出哨兵）。 */
  readonly maliciousScriptPath: string;
  /** 恶意初始化脚本的哨兵路径；断言其不存在即证明脚本未被执行。 */
  readonly maliciousSentinelPath: string;
  /** 真实 `git rev-parse HEAD`；无初始 commit 时为 null（不猜分支）。 */
  headOf(variant: RepoVariantKey): string | null;
  /** 真实 `git remote get-url origin`（无 origin 时抛错）。 */
  remoteOf(variant: RepoVariantKey): string;
  dispose(): void;
}

export type RepoVariantKey =
  | 'withHead'
  | 'noInitialCommit'
  | 'dirty'
  | 'cloneA'
  | 'cloneB'
  | 'alias'
  | 'malicious';

function writeRepoFiles(repoDir: string, files: Readonly<Record<string, string>>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(repoDir, ...relativePath.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf-8');
  }
}

/** 仓库内恶意初始化脚本源码：只写一个哨兵文件，行为被刻意限制。 */
function maliciousInitScriptSource(): string {
  return [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));",
    "const sentinel = join(repoRoot, 'MALICIOUS-INIT-RAN.txt');",
    "mkdirSync(dirname(sentinel), { recursive: true });",
    "writeFileSync(sentinel, `executed:${process.pid}\\n`);",
    '',
  ].join('\n');
}

/**
 * 在沙箱内创建全部仓库变体。准备中途失败时尽力收尾：自建沙箱整体删除，
 * 复用外部沙箱时只删除本次创建的 repos 子目录。
 */
export function createRepoVariants(options: CreateRepoVariantsOptions = {}): RepoVariants {
  const ownsSandbox = options.root === undefined;
  const sandbox = ownsSandbox
    ? createTempSandbox(options.prefix ?? 'shiploop-p02-3-repos-', { outside: [REPO_ROOT, homedir()] })
    : undefined;
  const root = realpathSync(sandbox ? sandbox.path : options.root!);
  const reposDir = join(root, 'repos');
  const homeDir = options.homeDir ?? join(root, 'home');

  const gitOptions = { home: homeDir };
  const protectedPaths = [REPO_ROOT, homedir()];
  const realTmp = realpathSync(tmpdir());

  function cleanupCreatedRepos(): void {
    if (!existsSync(reposDir)) {
      return;
    }
    safeRemoveTempRoot(reposDir, { authorizedRoot: root, protectedPaths });
  }

  function dispose(): void {
    if (ownsSandbox) {
      safeRemoveTempRoot(root, { authorizedRoot: realTmp, protectedPaths });
      return;
    }
    cleanupCreatedRepos();
  }

  try {
    mkdirSync(reposDir, { recursive: true, mode: 0o700 });
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });

    // 必需驱动核验（缺失即失败，不 skip）。
    assertGitAvailable();

    // 1. withHead：干净、有初始 commit（含最小 package.json，供未知 script 样例）。
    const withHead = join(reposDir, REPO_DIRS.withHead);
    initGitRepo(withHead);
    writeRepoFiles(withHead, {
      'README.md': '# with-head\n',
      'src/index.ts': 'export const marker = "with-head";\n',
      // 含 scripts 字段：使 `node --run <未知 script>` 命中「Missing script」语义。
      'package.json': JSON.stringify(
        {
          name: 'fixture-with-head-repo',
          private: true,
          version: '0.0.0',
          scripts: { noop: 'node --version' },
        },
        null,
        2,
      ),
    });
    commitAll(withHead, 'F-003 with-head initial commit', gitOptions);

    // 2. noInitialCommit：仅 git init，无 commit。
    const noInitialCommit = join(reposDir, REPO_DIRS.noInitialCommit);
    initGitRepo(noInitialCommit);

    // 3. dirty：有 HEAD，含已跟踪改动 + 未跟踪新文件。
    const dirty = join(reposDir, REPO_DIRS.dirty);
    initGitRepo(dirty);
    const dirtyTrackedFile = join(dirty, 'src', 'tracked.ts');
    writeRepoFiles(dirty, {
      'README.md': '# dirty\n',
      'src/tracked.ts': 'export const tracked = 1;\n',
    });
    commitAll(dirty, 'F-003 dirty initial commit', gitOptions);
    writeFileSync(dirtyTrackedFile, 'export const tracked = 2; // modified\n', 'utf-8');
    const dirtyUntrackedFile = join(dirty, 'untracked.txt');
    writeFileSync(dirtyUntrackedFile, 'untracked\n', 'utf-8');

    // 4. origin/cloneA/cloneB：同一本地 bare remote 的两个 clone。
    const origin = join(reposDir, REPO_DIRS.origin);
    initGitRepo(origin, { bare: true });
    const originSeed = join(reposDir, REPO_DIRS.originSeed);
    initGitRepo(originSeed);
    writeFileSync(join(originSeed, 'a.txt'), 'a\n', 'utf-8');
    commitAll(originSeed, 'F-003 origin seed', gitOptions);
    git(['remote', 'add', 'origin', origin], originSeed, gitOptions);
    git(['push', '--quiet', 'origin', 'main'], originSeed, gitOptions);
    const cloneA = join(reposDir, REPO_DIRS.cloneA);
    const cloneB = join(reposDir, REPO_DIRS.cloneB);
    git(['clone', '--quiet', origin, cloneA], reposDir, gitOptions);
    git(['clone', '--quiet', origin, cloneB], reposDir, gitOptions);

    // 5. alias：指向 withHead 的符号链接（路径别名）。
    const alias = join(reposDir, REPO_DIRS.alias);
    symlinkSync(realpathSync(withHead), alias);

    // 6. malicious：含恶意初始化脚本（postinstall/prepare 指向它）。
    const malicious = join(reposDir, REPO_DIRS.malicious);
    initGitRepo(malicious);
    writeRepoFiles(malicious, {
      'README.md': '# malicious\n',
      'package.json': JSON.stringify(
        {
          name: 'fixture-malicious-repo',
          private: true,
          version: '0.0.0',
          scripts: {
            postinstall: 'node scripts/evil-init.mjs',
            prepare: 'node scripts/evil-init.mjs',
          },
        },
        null,
        2,
      ),
      'scripts/evil-init.mjs': maliciousInitScriptSource(),
    });
    commitAll(malicious, 'F-003 malicious initial commit', gitOptions);
    const maliciousScriptPath = join(malicious, 'scripts', 'evil-init.mjs');
    const maliciousSentinelPath = join(malicious, 'MALICIOUS-INIT-RAN.txt');

    const pathFor: Record<RepoVariantKey, string> = {
      withHead,
      noInitialCommit,
      dirty,
      cloneA,
      cloneB,
      alias,
      malicious,
    };

    return {
      root,
      homeDir,
      ownsSandbox,
      withHead,
      noInitialCommit,
      dirty,
      dirtyTrackedFile,
      dirtyUntrackedFile,
      origin,
      cloneA,
      cloneB,
      alias,
      malicious,
      maliciousScriptPath,
      maliciousSentinelPath,
      headOf(variant: RepoVariantKey): string | null {
        const dir = pathFor[variant];
        try {
          const result = git(['rev-parse', '--verify', '--quiet', 'HEAD'], dir, gitOptions).trim();
          return result.length === 0 ? null : result;
        } catch {
          // 无初始 commit：rev-parse 以非零退出且无输出（不猜分支，返回 null）。
          return null;
        }
      },
      remoteOf(variant: RepoVariantKey): string {
        return git(['remote', 'get-url', 'origin'], pathFor[variant], gitOptions).trim();
      },
      dispose,
    };
  } catch (error) {
    // 准备失败尽力收尾：自建沙箱整体删除，复用外部沙箱时只删本次 repos 子目录。
    try {
      if (ownsSandbox) {
        safeRemoveTempRoot(root, { authorizedRoot: realTmp, protectedPaths });
      } else {
        cleanupCreatedRepos();
      }
    } catch {
      // 尽力收尾，不覆盖原始准备错误。
    }
    throw error;
  }
}
