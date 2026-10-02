/**
 * P01-3 / F-004 只读仓库路径检查适配器测试（真实临时 Git 仓库与真实 git 进程，非 mock）。
 *
 * 覆盖（F-004 验收点，全部为真实断言）：
 * - 真实临时仓库根及其符号链接别名得到同一 canonicalPath 与 repoIdentity；
 *   gitCommonDir 来自实际 `git rev-parse --git-common-dir` 并 realpath 规范化；
 *   repoIdentity 为稳定本地身份（gitdir-sha256 派生），remote 只作信息不作身份：
 *   同 remote 的两个 clone 身份不同，同一 clone 重检身份一致；
 * - 不存在路径、普通文件、非 Git 目录、仓库子目录（repository_root_required，不误
 *   绑定到外层仓库）、裸仓库与 .git 内部目录（bare_repository / not_a_worktree_root）
 *   返回带操作与结构化 reason 的错误，不创建项目或目录；
 * - 无初始 commit 与有未提交文件的受支持仓库完成只读检查；检查前后 HEAD、
 *   .git/index、工作文件与哨兵内容一致（GIT_OPTIONAL_LOCKS=0 保证只读）；
 * - Git 调用使用独立 argv、显式 cwd、有限超时与输出上限；含空格/Unicode/Shell
 *   元字符的目录名不触发注入；git 不可用、不可执行、超时、输出超限均返回结构化
 *   错误，不伪装成有效绑定；
 * - 错误脱敏：message 与 details 不含绝对路径或 stderr 原文；适配器不拼接 shell、
 *   不导入存储端口（Git/文件检查发生在数据库写事务之外由分层强制）。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  REPO_IDENTITY_PREFIX,
  REPOSITORY_INSPECTION_DEFAULT_MAX_OUTPUT_BYTES,
  REPOSITORY_INSPECTION_DEFAULT_TIMEOUT_MS,
  RepositoryInspectionError,
  deriveRepoIdentity,
  isRepositoryInspectionError,
  validateRepositoryInspectionPath,
} from '../packages/core/src/ports/repository-inspector.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import type { RepositoryInspector } from '../packages/core/src/ports/repository-inspector.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import { assertGitAvailable, commitAll, git, initGitRepo } from './helpers/git-repo.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_SOURCE_PATH = 'packages/core/src/adapters/fs/repository-inspector.ts';
const PORT_SOURCE_PATH = 'packages/core/src/ports/repository-inspector.ts';

let gitVersion = '';

beforeAll(() => {
  // 必需驱动缺失时失败而非 skip（F-013 原则）。
  gitVersion = assertGitAvailable();
});

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 结构化错误断言：kind/reason/operation + 脱敏（不含绝对路径与 stderr 原文）。 */
async function expectInspectionError(
  inspector: RepositoryInspector,
  input: unknown,
  kind: string,
  reason: string,
  protectedPaths: readonly string[],
): Promise<RepositoryInspectionError> {
  const failure = await inspector.inspect(input).then(
    () => {
      throw new Error(`预期 inspect 失败（${kind}/${reason}），实际成功`);
    },
    (error: unknown) => error,
  );
  expect(isRepositoryInspectionError(failure, kind as never)).toBe(true);
  const typed = failure as RepositoryInspectionError;
  expect(typed.operation).toBe('RepositoryInspector.inspect');
  expect(typed.details?.reason).toBe(reason);
  const serialized = `${typed.message} ${JSON.stringify(typed.details ?? {})}`;
  for (const protectedPath of protectedPaths) {
    expect(serialized).not.toContain(protectedPath);
  }
  expect(serialized).not.toContain('fatal:');
  return typed;
}

describe('P01-3 / F-004 只读仓库路径检查适配器', () => {
  it('规范真实仓库根并返回实际 Git 绑定信息（初始 commit + 脏状态）', async () => {
    const sandbox = createTempSandbox();
    try {
      const repo = join(sandbox.path, 'repo-a');
      initGitRepo(repo);
      writeFileSync(join(repo, 'README.md'), '# hello\n');
      const head = commitAll(repo, 'initial commit');
      writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');

      const inspector = createRepositoryInspector();
      const result = await inspector.inspect(repo);

      const realRepo = realpathSync(repo);
      expect(result.canonicalPath).toBe(realRepo);
      expect(result.gitCommonDir).toBe(realpathSync(join(realRepo, '.git')));
      expect(result.repoIdentity).toBe(deriveRepoIdentity(result.gitCommonDir as string));
      expect(result.repoIdentity.startsWith(REPO_IDENTITY_PREFIX)).toBe(true);
      expect(result.headCommit).toBe(head);
      expect(result.hasInitialCommit).toBe(true);
      expect(result.hasUncommittedChanges).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it('仓库根的符号链接别名解析为同一 canonicalPath 与 repoIdentity', async () => {
    const sandbox = createTempSandbox();
    try {
      const repo = join(sandbox.path, 'repo-real');
      initGitRepo(repo);
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      commitAll(repo, 'c1');
      const alias = join(sandbox.path, 'repo-alias');
      symlinkSync(realpathSync(repo), alias);

      const inspector = createRepositoryInspector();
      const viaReal = await inspector.inspect(repo);
      const viaAlias = await inspector.inspect(alias);

      expect(viaAlias.canonicalPath).toBe(viaReal.canonicalPath);
      expect(viaAlias.gitCommonDir).toBe(viaReal.gitCommonDir);
      expect(viaAlias.repoIdentity).toBe(viaReal.repoIdentity);
      expect(viaAlias.headCommit).toBe(viaReal.headCommit);
    } finally {
      sandbox.cleanup();
    }
  });

  it('无初始 commit 的仓库可完成只读身份检查（headCommit=null，不猜分支）', async () => {
    const sandbox = createTempSandbox();
    try {
      const repo = join(sandbox.path, 'repo-empty');
      initGitRepo(repo);

      const inspector = createRepositoryInspector();
      const cleanResult = await inspector.inspect(repo);
      expect(cleanResult.headCommit).toBeNull();
      expect(cleanResult.hasInitialCommit).toBe(false);
      expect(cleanResult.hasUncommittedChanges).toBe(false);

      // 有未提交（未跟踪）文件仍可检查，且如实报告脏状态。
      writeFileSync(join(repo, 'untracked.txt'), 'not committed\n');
      const dirtyResult = await inspector.inspect(repo);
      expect(dirtyResult.headCommit).toBeNull();
      expect(dirtyResult.hasInitialCommit).toBe(false);
      expect(dirtyResult.hasUncommittedChanges).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it('只读性：检查前后 HEAD、索引、工作文件与哨兵内容逐字节一致', async () => {
    const sandbox = createTempSandbox();
    try {
      const repo = join(sandbox.path, 'repo-readonly');
      initGitRepo(repo);
      writeFileSync(join(repo, 'tracked.txt'), 'tracked\n');
      commitAll(repo, 'c1');
      const sentinel = join(sandbox.path, 'sentinel.txt');
      writeFileSync(sentinel, 'sentinel-content\n');

      const headBefore = readFileSync(join(realpathSync(repo), '.git', 'HEAD'), 'utf8');
      const indexBefore = sha256OfFile(join(realpathSync(repo), '.git', 'index'));
      const statusBefore = git(['status', '--porcelain', '--untracked-files=normal'], repo);
      const listingBefore = readdirSync(repo).sort();

      const inspector = createRepositoryInspector();
      const result = await inspector.inspect(repo);
      expect(result.hasUncommittedChanges).toBe(false);

      expect(readFileSync(join(realpathSync(repo), '.git', 'HEAD'), 'utf8')).toBe(headBefore);
      expect(sha256OfFile(join(realpathSync(repo), '.git', 'index'))).toBe(indexBefore);
      expect(git(['status', '--porcelain', '--untracked-files=normal'], repo)).toBe(statusBefore);
      expect(readdirSync(repo).sort()).toEqual(listingBefore);
      expect(readFileSync(sentinel, 'utf8')).toBe('sentinel-content\n');
    } finally {
      sandbox.cleanup();
    }
  });

  it('不存在路径返回 not_found，且不创建任何项目或目录', async () => {
    const sandbox = createTempSandbox();
    try {
      const inspector = createRepositoryInspector();
      const missing = join(sandbox.path, 'no-such-repo');
      await expectInspectionError(inspector, missing, 'not_found', 'path_not_found', [
        sandbox.path,
      ]);
      expect(readdirSync(sandbox.path)).toEqual([]);
      expect(existsSync(missing)).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });

  it('普通文件返回 not_a_directory', async () => {
    const sandbox = createTempSandbox();
    try {
      const file = join(sandbox.path, 'plain.txt');
      writeFileSync(file, 'not a directory\n');
      const inspector = createRepositoryInspector();
      await expectInspectionError(inspector, file, 'not_a_directory', 'path_not_directory', [
        sandbox.path,
      ]);
    } finally {
      sandbox.cleanup();
    }
  });

  it('非 Git 目录返回 not_a_repository（not_a_git_repository），不创建目录', async () => {
    const sandbox = createTempSandbox();
    try {
      const plain = join(sandbox.path, 'plain-dir');
      mkdirSync(plain);
      writeFileSync(join(plain, 'file.txt'), 'x\n');
      const inspector = createRepositoryInspector();
      await expectInspectionError(inspector, plain, 'not_a_repository', 'not_a_git_repository', [
        sandbox.path,
      ]);
      expect(readdirSync(plain).sort()).toEqual(['file.txt']);
    } finally {
      sandbox.cleanup();
    }
  });

  it('仓库子目录明确拒绝（repository_root_required），不误绑定到外层仓库', async () => {
    const sandbox = createTempSandbox();
    try {
      const repo = join(sandbox.path, 'repo-root');
      initGitRepo(repo);
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      commitAll(repo, 'c1');
      const subdir = join(repo, 'src', 'nested');
      mkdirSync(subdir, { recursive: true });

      const inspector = createRepositoryInspector();
      const failure = await expectInspectionError(
        inspector,
        subdir,
        'not_a_repository',
        'repository_root_required',
        [sandbox.path],
      );
      // 不把外层仓库的 canonicalPath 当作有效绑定返回。
      expect(isRepositoryInspectionError(failure, 'not_a_repository')).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it('裸仓库与 .git 内部目录明确拒绝（bare_repository / not_a_worktree_root）', async () => {
    const sandbox = createTempSandbox();
    try {
      const bare = join(sandbox.path, 'repo-bare');
      initGitRepo(bare, { bare: true });
      const workRepo = join(sandbox.path, 'repo-work');
      initGitRepo(workRepo);
      writeFileSync(join(workRepo, 'a.txt'), 'a\n');
      commitAll(workRepo, 'c1');

      const inspector = createRepositoryInspector();
      await expectInspectionError(inspector, bare, 'not_a_repository', 'bare_repository', [
        sandbox.path,
      ]);
      await expectInspectionError(
        inspector,
        join(workRepo, '.git'),
        'not_a_repository',
        'not_a_worktree_root',
        [sandbox.path],
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it('linked worktree 顶层明确接受：gitCommonDir 指向主仓库公共目录且身份一致', async () => {
    const sandbox = createTempSandbox();
    try {
      const main = join(sandbox.path, 'repo-main');
      initGitRepo(main);
      writeFileSync(join(main, 'a.txt'), 'a\n');
      commitAll(main, 'c1');
      const linked = join(sandbox.path, 'repo-linked');
      git(['worktree', 'add', '--detach', linked, 'HEAD'], main);

      const inspector = createRepositoryInspector();
      const mainResult = await inspector.inspect(main);
      const linkedResult = await inspector.inspect(linked);

      expect(linkedResult.canonicalPath).toBe(realpathSync(linked));
      expect(linkedResult.gitCommonDir).toBe(mainResult.gitCommonDir);
      // 同一底层仓库的不同 checkout：身份一致，canonicalPath 不同（canonical_path 唯一约束仍分离两者）。
      expect(linkedResult.repoIdentity).toBe(mainResult.repoIdentity);
      expect(linkedResult.canonicalPath).not.toBe(mainResult.canonicalPath);
      expect(linkedResult.hasInitialCommit).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it('同 remote 的两个 clone 身份与 canonicalPath 不同；同一 clone 重检身份一致', async () => {
    const sandbox = createTempSandbox();
    try {
      const origin = join(sandbox.path, 'origin');
      initGitRepo(origin, { bare: true });
      const seed = join(sandbox.path, 'seed');
      initGitRepo(seed);
      writeFileSync(join(seed, 'a.txt'), 'a\n');
      commitAll(seed, 'c1');
      git(['remote', 'add', 'origin', origin], seed);
      git(['push', '--quiet', 'origin', 'main'], seed);

      const cloneA = join(sandbox.path, 'clone-a');
      const cloneB = join(sandbox.path, 'clone-b');
      git(['clone', '--quiet', origin, cloneA], sandbox.path);
      git(['clone', '--quiet', origin, cloneB], sandbox.path);

      const inspector = createRepositoryInspector();
      const a1 = await inspector.inspect(cloneA);
      const a2 = await inspector.inspect(cloneA);
      const b1 = await inspector.inspect(cloneB);

      // remote 相同（同 origin）但 local 身份不合并：clone 是不同仓库。
      expect(git(['remote', 'get-url', 'origin'], cloneA).trim()).toBe(
        git(['remote', 'get-url', 'origin'], cloneB).trim(),
      );
      expect(a1.canonicalPath).not.toBe(b1.canonicalPath);
      expect(a1.repoIdentity).not.toBe(b1.repoIdentity);
      expect(a1.repoIdentity).toBe(a2.repoIdentity);
      expect(a1.headCommit).toBe(b1.headCommit);
    } finally {
      sandbox.cleanup();
    }
  });

  it('目录名含空格、Unicode 与 Shell 元字符不触发命令注入', async () => {
    const sandbox = createTempSandbox();
    try {
      const weirdName = 'repo 测;$(touch injected)`id`&injected2';
      const repo = join(sandbox.path, weirdName);
      initGitRepo(repo);
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      commitAll(repo, 'c1');

      const inspector = createRepositoryInspector();
      const result = await inspector.inspect(repo);
      expect(result.canonicalPath).toBe(realpathSync(repo));
      expect(result.hasInitialCommit).toBe(true);

      // 注入哨兵：任何 shell 解释都会留下这些文件；独立 argv 下必须不存在。
      expect(existsSync(join(sandbox.path, 'injected'))).toBe(false);
      expect(existsSync(join(sandbox.path, 'injected2'))).toBe(false);
      expect(existsSync(join(repo, 'injected'))).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });

  it('git 不可用或不可执行返回 unavailable/permission，不伪装成有效绑定', async () => {
    const sandbox = createTempSandbox();
    try {
      const repo = join(sandbox.path, 'repo');
      initGitRepo(repo);

      const missingGit = createRepositoryInspector({
        gitExecutable: join(sandbox.path, 'definitely-missing-git'),
      });
      await expectInspectionError(missingGit, repo, 'unavailable', 'git_not_found', [sandbox.path]);

      const notExecutable = join(sandbox.path, 'not-executable-git');
      writeFileSync(notExecutable, '#!/bin/sh\nexit 1\n', { mode: 0o644 });
      const permissionGit = createRepositoryInspector({ gitExecutable: notExecutable });
      await expectInspectionError(permissionGit, repo, 'permission', 'git_not_executable', [
        sandbox.path,
      ]);
    } finally {
      sandbox.cleanup();
    }
  });

  it('有限超时返回 timeout（timeoutMs=1 真实进程必超时），不伪装成有效绑定', async () => {
    const sandbox = createTempSandbox();
    try {
      const repo = join(sandbox.path, 'repo');
      initGitRepo(repo);
      const inspector = createRepositoryInspector({ timeoutMs: 1 });
      await expectInspectionError(inspector, repo, 'timeout', 'git_timeout', [sandbox.path]);
    } finally {
      sandbox.cleanup();
    }
  });

  it('输出上限触发时返回结构化错误（output_limit_exceeded）而非截断结果', async () => {
    const sandbox = createTempSandbox();
    try {
      const repo = join(sandbox.path, 'repo');
      initGitRepo(repo);
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      commitAll(repo, 'c1');
      // 制造足够大的 status 输出：每个未跟踪条目一行 porcelain 输出。
      for (let index = 0; index < 64; index += 1) {
        writeFileSync(join(repo, `untracked-file-with-a-long-name-${String(index).padStart(3, '0')}.txt`), 'x\n');
      }
      const canonical = realpathSync(repo);
      // 上限大于各 rev-parse 输出（最长为 canonicalPath 本身），小于 status 输出。
      const limit = canonical.length + 64;
      const porcelainSize = git(['status', '--porcelain', '--untracked-files=normal'], repo).length;
      expect(porcelainSize).toBeGreaterThan(limit);

      const inspector = createRepositoryInspector({ maxOutputBytes: limit });
      await expectInspectionError(inspector, repo, 'io', 'output_limit_exceeded', [sandbox.path]);
    } finally {
      sandbox.cleanup();
    }
  });

  it('非法输入（相对路径/空串/非字符串/NUL）返回 invalid_input，不触碰文件系统', async () => {
    const sandbox = createTempSandbox();
    try {
      const inspector = createRepositoryInspector();
      const cases: Array<{ input: unknown; reason: string }> = [
        { input: 42, reason: 'path_not_string' },
        { input: null, reason: 'path_not_string' },
        { input: '', reason: 'path_empty' },
        { input: '   ', reason: 'path_empty' },
        { input: 'relative/path', reason: 'path_not_absolute' },
        { input: '/abs/with\0nul', reason: 'path_nul' },
      ];
      for (const { input, reason } of cases) {
        await expectInspectionError(inspector, input, 'invalid_input', reason, [sandbox.path]);
      }
      expect(readdirSync(sandbox.path)).toEqual([]);
    } finally {
      sandbox.cleanup();
    }
  });

  it('装配参数校验：非法 gitExecutable/timeoutMs/maxOutputBytes 在创建时拒绝', () => {
    const invalid: Array<unknown> = [
      null,
      42,
      { gitExecutable: '' },
      { gitExecutable: 7 },
      { timeoutMs: 0 },
      { timeoutMs: -1 },
      { timeoutMs: 1.5 },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { timeoutMs: 1_000_000_000 },
      { maxOutputBytes: 0 },
      { maxOutputBytes: 1.5 },
      { maxOutputBytes: 1024 * 1024 * 1024 },
      { unknownOption: true },
    ];
    for (const options of invalid) {
      expect(() => createRepositoryInspector(options as never)).toThrow(RepositoryInspectionError);
      try {
        createRepositoryInspector(options as never);
        throw new Error('预期创建失败');
      } catch (error) {
        expect(isRepositoryInspectionError(error, 'invalid_input')).toBe(true);
        expect((error as RepositoryInspectionError).operation).toBe('RepositoryInspector.create');
      }
    }
    // 默认值是有限且可用的。
    expect(REPOSITORY_INSPECTION_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(REPOSITORY_INSPECTION_DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(() => createRepositoryInspector()).not.toThrow();
    expect(() => createRepositoryInspector({})).not.toThrow();
  });

  it('纯校验器 validateRepositoryInspectionPath：绝对 POSIX 路径原样返回', () => {
    expect(validateRepositoryInspectionPath('/tmp/repo', 'op')).toBe('/tmp/repo');
    expect(() => validateRepositoryInspectionPath('repo', 'op')).toThrow(RepositoryInspectionError);
    try {
      validateRepositoryInspectionPath('repo', 'op');
    } catch (error) {
      expect((error as RepositoryInspectionError).operation).toBe('op');
    }
  });

  it('deriveRepoIdentity 是纯确定性派生：同一 gitCommonDir 一致，不同则不同', () => {
    const first = deriveRepoIdentity('/repos/a/.git');
    expect(first).toBe(deriveRepoIdentity('/repos/a/.git'));
    expect(first).not.toBe(deriveRepoIdentity('/repos/b/.git'));
    expect(first.startsWith(REPO_IDENTITY_PREFIX)).toBe(true);
    expect(first.length).toBe(REPO_IDENTITY_PREFIX.length + 64);
    expect(() => deriveRepoIdentity('')).toThrow(RepositoryInspectionError);
    expect(() => deriveRepoIdentity(42 as unknown as string)).toThrow(RepositoryInspectionError);
  });

  it('端口与适配器源码卫生：不拼接 shell、不触碰存储/网络/Pi SDK', () => {
    const adapterSource = readFileSync(resolve(REPO_ROOT, ADAPTER_SOURCE_PATH), 'utf8');
    const portSource = readFileSync(resolve(REPO_ROOT, PORT_SOURCE_PATH), 'utf8');
    // 只允许独立 argv 的 execFile：禁止 shell 解释与原始 spawn/exec 形式。
    expect(adapterSource).not.toMatch(/shell\s*:/);
    expect(adapterSource).not.toMatch(/\bexec\s*\(/);
    expect(adapterSource).not.toMatch(/\bspawn\s*\(/);
    expect(adapterSource).not.toContain('execSync');
    // Git/文件检查不接触数据库：适配器不导入存储端口或驱动。
    expect(adapterSource).not.toContain('better-sqlite3');
    expect(adapterSource).not.toContain('drizzle');
    expect(adapterSource).not.toContain('adapters/sqlite');
    // 端口是纯契约：无子进程/文件系统/网络依赖（公共类型不依赖 HTTP、Pi SDK 或 ORM）。
    expect(portSource).not.toContain('node:child_process');
    expect(portSource).not.toContain('node:fs');
    expect(portSource).not.toContain('node:http');
    expect(portSource).not.toContain('pi-coding-agent');
  });
});
