/**
 * P01-3 / F-004 只读仓库路径检查适配器（adapters 层，
 * ports/repository-inspector.ts 契约的真实 Git + 文件系统实现）。
 *
 * 设计依据：core-design/06 §1（规范路径 + Git 与脏状态识别；不执行仓库脚本、
 * 不安装依赖；已有脏工作区不自动 stash/reset；无初始 commit 不猜 main）、
 * core-design/03 §1（canonical_path 唯一、remote 非唯一身份）与
 * docs/p01-3-application-contract.md §4.2。
 *
 * 不变量：
 * - 只读：只调用 rev-parse / status 等只读子命令；子进程环境固定
 *   GIT_OPTIONAL_LOCKS=0（git status 不得 opportunistic 刷新索引），检查前后
 *   HEAD、索引与工作文件一致；绝不 commit/stash/reset/fetch/install/执行仓库脚本；
 * - Git 调用一律经 execFile 独立 argv + 显式 cwd（已 realpath 的候选仓库根），
 *   不经过 shell 解释：目录名含空格/Unicode/Shell 元字符不触发注入；每次调用
 *   携带有限超时（timeoutMs）与输出上限（maxOutputBytes），超限即终止并返回
 *   结构化错误，绝不截断后伪装成有效结果；
 * - 子进程环境最小且确定：仅 PATH + LC_ALL=C + GIT_CONFIG_NOSYSTEM/
 *   GIT_CONFIG_SYSTEM/GIT_CONFIG_GLOBAL 隔离机器配置 + GIT_TERMINAL_PROMPT=0
 *   禁止交互；不读取用户 gitconfig、不触网、不解析凭据；
 * - canonicalPath 由 realpath 输入路径得到（符号链接别名收敛到同一真实根）；
 *   gitCommonDir 来自实际 `git rev-parse --git-common-dir` 并 realpath 规范化；
 *   repoIdentity = deriveRepoIdentity(gitCommonDir)（稳定本地身份，remote 不参与）；
 * - 支持范围（F-004 实施契约，见契约文档 §4.2/§9-6）：接受工作树根（含无初始
 *   commit、脏工作区）与 linked worktree 顶层；拒绝不存在路径、普通文件、非 Git
 *   目录、仓库子目录（repository_root_required，不误绑定到外层仓库）、裸仓库与
 *   .git 内部目录（bare_repository / not_a_worktree_root）；
 * - HEAD 识别：`rev-parse --verify --quiet` 退出码 1 = 无初始 commit（headCommit
 *   = null）；其余非零退出是真实 Git 错误，不混淆为"空仓库"；
 * - 本适配器不接触数据库/存储端口：Git 与文件系统检查发生在任何写事务之外
 *   （F-005 ProjectService 先完成检查再进短事务）；
 * - 错误脱敏：RepositoryInspectionError 的 message/details 只含 operation、
 *   reason 码与退出码/信号，不含绝对路径、stderr 原文或凭据；
 * - import 本模块无副作用；createRepositoryInspector 只校验装配参数，不触发
 *   任何进程或文件系统操作。
 *
 * 本模块不实现：仓库注册事务（F-005）、存量基线扫描/静态扫描（R2，不在本
 * Feature）、rebind、Task 策略复制、Runtime 调用。
 */
import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  REPOSITORY_INSPECTION_DEFAULT_MAX_OUTPUT_BYTES,
  REPOSITORY_INSPECTION_DEFAULT_TIMEOUT_MS,
  REPOSITORY_INSPECTION_MAX_MAX_OUTPUT_BYTES,
  REPOSITORY_INSPECTION_MAX_TIMEOUT_MS,
  RepositoryInspectionError,
  deriveRepoIdentity,
  validateRepositoryInspectionPath,
} from '../../ports/repository-inspector.js';
import type {
  RepositoryInspection,
  RepositoryInspectionErrorKind,
  RepositoryInspector,
} from '../../ports/repository-inspector.js';

const OPERATION = 'RepositoryInspector.inspect';

/** 已解析的装配配置（全部有限且有界）。 */
interface ResolvedInspectorConfig {
  readonly gitExecutable: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface RepositoryInspectorOptions {
  /** Git 可执行文件（默认 'git'，经 PATH 解析；测试可注入以模拟不可用/不可执行）。 */
  readonly gitExecutable?: string;
  /** 单次 Git 调用有限超时（毫秒）；默认与上限见端口常量。 */
  readonly timeoutMs?: number;
  /** 单次 Git 调用输出上限（字节）；超限报错而非截断。 */
  readonly maxOutputBytes?: number;
}

/** Git 调用失败的内部形态（不跨端口边界；映射为 RepositoryInspectionError 后透出）。 */
class GitCommandFailure extends Error {
  /** 进程未能启动时的 errno（如 ENOENT/EACCES）。 */
  readonly spawnErrno: string | undefined;
  /** 进程正常启动后的退出码（非 0）。 */
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;
  /** 被超时机制终止。 */
  readonly timedOut: boolean;
  /** stdout/stderr 超出 maxOutputBytes。 */
  readonly outputLimitExceeded: boolean;
  /** stderr 原文：仅内部判定（如识别 "not a git repository"），绝不进入透出错误。 */
  readonly stderrText: string;

  constructor(fields: {
    readonly spawnErrno?: string;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly timedOut: boolean;
    readonly outputLimitExceeded: boolean;
    readonly stderrText: string;
  }) {
    super('git read-only invocation failed');
    this.name = 'GitCommandFailure';
    this.spawnErrno = fields.spawnErrno;
    this.exitCode = fields.exitCode;
    this.signal = fields.signal;
    this.timedOut = fields.timedOut;
    this.outputLimitExceeded = fields.outputLimitExceeded;
    this.stderrText = fields.stderrText;
  }
}

/** 最小确定的 Git 子进程环境：隔离机器配置、禁止交互、保证只读。 */
function buildGitEnvironment(): Record<string, string> {
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

/** 以独立 argv + 显式 cwd 执行一次只读 Git 调用；成功返回 stdout，失败抛 GitCommandFailure。 */
function runGitReadOnly(config: ResolvedInspectorConfig, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      config.gitExecutable,
      [...args],
      {
        cwd,
        env: buildGitEnvironment(),
        timeout: config.timeoutMs,
        maxBuffer: config.maxOutputBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise(stdout);
          return;
        }
        const nodeError = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: string | null;
        };
        const exitCode = typeof nodeError.code === 'number' ? nodeError.code : undefined;
        const spawnErrno = typeof nodeError.code === 'string' ? nodeError.code : undefined;
        const signal = typeof nodeError.signal === 'string' ? nodeError.signal : undefined;
        rejectPromise(
          new GitCommandFailure({
            ...(spawnErrno !== undefined ? { spawnErrno } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(signal !== undefined ? { signal } : {}),
            timedOut: nodeError.killed === true,
            outputLimitExceeded:
              spawnErrno === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
              (typeof error.message === 'string' && error.message.includes('maxBuffer')),
            stderrText: typeof stderr === 'string' ? stderr : String(stderr),
          }),
        );
      },
    );
  });
}

function inspectionError(
  kind: RepositoryInspectionErrorKind,
  message: string,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): RepositoryInspectionError {
  return new RepositoryInspectionError(kind, OPERATION, `${OPERATION}: ${message}`, {
    details,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** GitCommandFailure → 透出错误（脱敏：reason 码 + 退出码/信号，无路径与 stderr 原文）。 */
function mapGitFailure(failure: GitCommandFailure): RepositoryInspectionError {
  if (failure.spawnErrno === 'ENOENT') {
    return inspectionError('unavailable', 'Git 可执行文件不可用', { reason: 'git_not_found' }, failure);
  }
  if (failure.spawnErrno === 'EACCES' || failure.spawnErrno === 'EPERM') {
    return inspectionError('permission', 'Git 可执行文件权限拒绝', { reason: 'git_not_executable' }, failure);
  }
  if (failure.timedOut) {
    return inspectionError('timeout', 'Git 调用超出有限超时被终止', { reason: 'git_timeout' }, failure);
  }
  if (failure.outputLimitExceeded) {
    return inspectionError('io', 'Git 输出超出上限，拒绝截断结果', { reason: 'output_limit_exceeded' }, failure);
  }
  return inspectionError(
    'io',
    'Git 调用失败',
    {
      reason: 'git_error',
      ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
      ...(failure.signal !== undefined ? { signal: failure.signal } : {}),
    },
    failure,
  );
}

/** 文件系统运行期条件 → 透出错误（脱敏：只含 reason 与 errno code）。 */
function mapFsFailure(error: unknown): RepositoryInspectionError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') {
    return inspectionError('not_found', '路径不存在', { reason: 'path_not_found', code }, error);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return inspectionError('permission', '文件系统权限拒绝', { reason: 'fs_permission_denied', code }, error);
  }
  return inspectionError('io', '文件系统操作失败', { reason: 'fs_error', code: code ?? 'unknown' }, error);
}

/** 输入路径 → 已 realpath 的真实目录（符号链接别名收敛）；不存在/非目录结构化拒绝。 */
function resolveExistingDirectory(inputPath: string): string {
  let real: string;
  try {
    real = realpathSync(inputPath);
  } catch (error) {
    throw mapFsFailure(error);
  }
  if (real === sep) {
    throw inspectionError('invalid_input', '拒绝把文件系统根作为仓库根', {
      reason: 'repository_root_unsafe',
    });
  }
  let stat;
  try {
    stat = lstatSync(real);
  } catch (error) {
    throw mapFsFailure(error);
  }
  if (!stat.isDirectory()) {
    throw inspectionError('not_a_directory', '路径存在但不是目录', { reason: 'path_not_directory' });
  }
  return real;
}

/**
 * 执行 rev-parse 类探测命令：把 Git "not a git repository"  fatal 映射为
 * not_a_repository；其余失败经 mapGitFailure 透出。
 */
async function runDetectionGit(
  config: ResolvedInspectorConfig,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    return await runGitReadOnly(config, args, cwd);
  } catch (error) {
    if (error instanceof GitCommandFailure) {
      if (error.exitCode === 128 && error.stderrText.includes('not a git repository')) {
        throw inspectionError('not_a_repository', '目录不在任何 Git 仓库之内', {
          reason: 'not_a_git_repository',
        });
      }
      throw mapGitFailure(error);
    }
    throw error;
  }
}

/** 解析单行路径输出：去掉行尾换行；含嵌入换行/为空视为无法解析（不猜）。 */
function parseSinglePathOutput(raw: string, reason: string): string {
  const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0 || trimmed.includes('\n')) {
    throw inspectionError('io', 'Git 输出形态无法解析', { reason });
  }
  return trimmed;
}

function realpathGitPath(candidate: string, reason: string): string {
  try {
    return realpathSync(candidate);
  } catch (error) {
    throw inspectionError('io', 'Git 报告的元数据位置无法解析', { reason }, error);
  }
}

function validateOptions(options: RepositoryInspectorOptions | undefined): ResolvedInspectorConfig {
  const operation = 'RepositoryInspector.create';
  const fail = (reason: string, message: string): never => {
    throw new RepositoryInspectionError('invalid_input', operation, `${operation}: ${message}`, {
      details: { reason },
    });
  };
  if (options === undefined) {
    options = {};
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('options_not_object', '装配参数必须是对象');
  }
  const record = options as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'gitExecutable' && key !== 'timeoutMs' && key !== 'maxOutputBytes') {
      fail('unknown_option', `未知装配参数 ${key}`);
    }
  }
  const gitExecutable = record.gitExecutable ?? 'git';
  if (typeof gitExecutable !== 'string' || gitExecutable.length === 0 || gitExecutable.includes('\0')) {
    fail('git_executable_invalid', 'gitExecutable 必须是不含 NUL 的非空字符串');
  }
  const timeoutMs = record.timeoutMs ?? REPOSITORY_INSPECTION_DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > REPOSITORY_INSPECTION_MAX_TIMEOUT_MS
  ) {
    fail('timeout_invalid', `timeoutMs 必须是 1..${REPOSITORY_INSPECTION_MAX_TIMEOUT_MS} 的整数毫秒`);
  }
  const maxOutputBytes = record.maxOutputBytes ?? REPOSITORY_INSPECTION_DEFAULT_MAX_OUTPUT_BYTES;
  if (
    typeof maxOutputBytes !== 'number' ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 16 ||
    maxOutputBytes > REPOSITORY_INSPECTION_MAX_MAX_OUTPUT_BYTES
  ) {
    fail(
      'max_output_invalid',
      `maxOutputBytes 必须是 16..${REPOSITORY_INSPECTION_MAX_MAX_OUTPUT_BYTES} 的整数字节`,
    );
  }
  return {
    gitExecutable: gitExecutable as string,
    timeoutMs: timeoutMs as number,
    maxOutputBytes: maxOutputBytes as number,
  };
}

/**
 * 装配只读仓库检查端口实现。只做参数校验；所有 Git/文件系统检查延迟到 inspect，
 * 且发生在任何数据库写事务之外（本适配器不接触存储端口）。
 */
export function createRepositoryInspector(options?: RepositoryInspectorOptions): RepositoryInspector {
  const config = validateOptions(options);

  async function inspect(pathInput: unknown): Promise<RepositoryInspection> {
    const inputPath = validateRepositoryInspectionPath(pathInput, OPERATION);
    const canonicalPath = resolveExistingDirectory(inputPath);

    // 1. 工作树判定：非 Git 目录 / 裸仓库 / .git 内部目录在此明确拒绝。
    const insideOut = await runDetectionGit(
      config,
      ['rev-parse', '--is-inside-work-tree'],
      canonicalPath,
    );
    const insideWorkTree = insideOut.trim();
    if (insideWorkTree !== 'true' && insideWorkTree !== 'false') {
      throw inspectionError('io', 'Git 输出形态无法解析', { reason: 'unexpected_git_output' });
    }
    if (insideWorkTree === 'false') {
      const bareOut = await runDetectionGit(
        config,
        ['rev-parse', '--is-bare-repository'],
        canonicalPath,
      );
      const reason = bareOut.trim() === 'true' ? 'bare_repository' : 'not_a_worktree_root';
      throw inspectionError('not_a_repository', '不是受支持的工作树根（裸仓库或 .git 内部目录）', {
        reason,
      });
    }

    // 2. 根目录契约：输入必须就是工作树根；子目录拒绝，不绑定到外层仓库。
    const toplevelRaw = await runDetectionGit(config, ['rev-parse', '--show-toplevel'], canonicalPath);
    const toplevel = realpathGitPath(
      parseSinglePathOutput(toplevelRaw, 'unexpected_git_output'),
      'git_toplevel_unresolvable',
    );
    if (toplevel !== canonicalPath) {
      throw inspectionError('not_a_repository', '输入是仓库子目录；请提供工作树根（不误绑定到外层仓库）', {
        reason: 'repository_root_required',
      });
    }

    // 3. 公共元数据目录：实际 Git 解析 + realpath 规范化（linked worktree 指向主仓库）。
    const commonRaw = await runDetectionGit(config, ['rev-parse', '--git-common-dir'], canonicalPath);
    const commonParsed = parseSinglePathOutput(commonRaw, 'unexpected_git_output');
    const commonAbsolute = isAbsolute(commonParsed) ? commonParsed : resolve(canonicalPath, commonParsed);
    const gitCommonDir = realpathGitPath(commonAbsolute, 'git_common_dir_unresolvable');

    // 4. HEAD：--verify --quiet 退出码 1 = 无初始 commit；其余失败是真实 Git 错误。
    let headCommit: string | null;
    try {
      const headRaw = await runGitReadOnly(
        config,
        ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
        canonicalPath,
      );
      const candidate = headRaw.trim();
      if (!/^[0-9a-f]{40}$/.test(candidate) && !/^[0-9a-f]{64}$/.test(candidate)) {
        throw inspectionError('io', 'Git 输出形态无法解析', { reason: 'unexpected_git_output' });
      }
      headCommit = candidate;
    } catch (error) {
      if (error instanceof GitCommandFailure && !error.timedOut && error.exitCode === 1) {
        headCommit = null;
      } else if (error instanceof GitCommandFailure) {
        throw mapGitFailure(error);
      } else {
        throw error;
      }
    }

    // 5. 脏状态：porcelain 输出非空即有未提交变更（含未跟踪）；显式旗标覆盖仓库配置。
    let statusRaw: string;
    try {
      statusRaw = await runGitReadOnly(
        config,
        ['status', '--porcelain', '--untracked-files=normal'],
        canonicalPath,
      );
    } catch (error) {
      if (error instanceof GitCommandFailure) {
        throw mapGitFailure(error);
      }
      throw error;
    }
    const hasUncommittedChanges = statusRaw.trim().length > 0;

    return {
      canonicalPath,
      gitCommonDir,
      repoIdentity: deriveRepoIdentity(gitCommonDir),
      headCommit,
      hasInitialCommit: headCommit !== null,
      hasUncommittedChanges,
    };
  }

  return { inspect };
}
