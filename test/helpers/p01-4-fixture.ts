/**
 * P01-4 / F-002 P01 验收夹具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 目标：为 F-003 ~ F-009 的阶段验收提供**真实、可复现、安全收尾**的临时资源：
 * - 每次创建独立系统临时根，内含隔离临时 HOME、受控数据根与真实 Git 仓库；
 *   仓库路径与内部文件含 Unicode/空格；携带项目标签、合法配置与固定制品字节；
 * - Git 子进程使用一次性注入身份与最小确定环境（GIT_CONFIG_GLOBAL=/dev/null），
 *   不读取用户全局配置、认证文件或真实数据根；
 * - 真实 SQLite 驱动在准备期探测（`sqlite_version()`），Git 版本一并记录；缺失必需
 *   工具时显式失败而非 skip；
 * - 业务输入为固定常量，两次创建得到不同临时根但相同业务输入摘要（SHA-256）；
 * - 支持对源仓库（哨兵/HEAD/工作文件）做稳定快照；证据先序列化到**独立报告目录**，
 *   再删除临时业务资源，报告在业务清理后仍可读；
 * - `cleanup()` 只删除本次持有且位于临时授权根内的业务资源，拒绝未知根、受保护用户
 *   仓库与符号链接逃逸；`dispose()` 进一步回收报告与守卫目录。
 *
 * 供应给后继任务的 `openApplication()` 经公开 Core 装配入口
 * （`packages/core/src/adapters/composition.ts`）打开同一数据根，使用确定性时钟并
 * 登记受管应用，清理时统一关闭，避免失败路径遗留数据库句柄。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCoreApplication } from '../../packages/core/src/adapters/composition.ts';
import type { CoreApplication } from '../../packages/core/src/adapters/composition.ts';
import { openSqliteConnection } from '../../packages/core/src/adapters/sqlite/connection.ts';
import {
  createStaticRuntimeCapabilityCatalog,
} from '../../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../../packages/core/src/ports/runtime-capabilities.ts';
import { assertGitAvailable, commitAll, git, initGitRepo } from './git-repo.ts';
import { isInsideDirectory, safeRemoveTempRoot } from './safe-cleanup.ts';
import { createTempSandbox } from './temp-sandbox.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ------------------------------------------------------------------ *
 * 固定业务输入与摘要
 * ------------------------------------------------------------------ */

export interface P01BusinessInput {
  readonly project: {
    readonly displayName: string;
    readonly description: string;
    readonly labels: readonly string[];
  };
  /** 合法全局配置（schemaVersion=2，与夹具能力目录一致）。 */
  readonly globalSettings: Readonly<Record<string, unknown>>;
  /** 合法项目覆盖（携带凭据/端点引用，只保存引用）。 */
  readonly projectSettings: Readonly<Record<string, unknown>>;
  /** 固定制品：类别/媒体类型/逻辑 locator/版本与固定正文。 */
  readonly artifact: {
    readonly kind: string;
    readonly mediaType: string;
    readonly locator: string;
    readonly version: number;
    readonly content: string;
  };
  readonly repo: {
    readonly directoryName: string;
    readonly commitMessage: string;
    readonly sentinelFileName: string;
    readonly sentinelContent: string;
    readonly files: Readonly<Record<string, string>>;
  };
}

/**
 * 返回**全新**的固定业务输入对象（每次调用互不共享引用，避免跨夹具污染）。
 * 输入本身是确定常量：同一实现版本下所有运行生成相同摘要。
 */
export function p01BusinessInput(): P01BusinessInput {
  return {
    project: {
      displayName: '船舶循环验收项目',
      description: 'P01-4 固定夹具：Unicode 🚀 与 Markdown **说明** 原样保留',
      labels: ['Core', '核心', '验收'],
    },
    globalSettings: {
      schemaVersion: 2,
      strategies: {
        defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      },
      policies: {
        executionLimits: {
          maxConcurrentWorks: 1,
          workTimeoutMs: 600_000,
          maxAttemptsPerTask: 3,
          envAllowlist: ['PATH', 'LANG'],
        },
        verification: { requireChecksBeforeDone: true },
        securityPolicy: { isolation: 'trusted_project' },
      },
    },
    projectSettings: {
      schemaVersion: 2,
      strategies: {
        defaultStrategy: {
          runtime: 'pi',
          provider: 'anthropic',
          model: 'claude-sonnet',
          credentialRef: 'credref-fixture-1',
          endpointRef: 'endpoint-fixture-1',
        },
      },
      policies: { verification: { requireChecksBeforeDone: true } },
    },
    artifact: {
      kind: 'verification-report',
      mediaType: 'text/markdown; charset=utf-8',
      locator: 'artifacts/reports/p01-4-fixture.md',
      version: 1,
      content: '# P01-4 固定制品\n\n多字节内容 🚢 与稳定字节\n',
    },
    repo: {
      directoryName: '仓库 船舶-循环 🚀',
      commitMessage: 'P01-4 fixture initial commit',
      sentinelFileName: '.p01-fixture-sentinel',
      sentinelContent: 'P01-4 source repo sentinel — content is fixed\n',
      files: {
        'README.md': '# 船舶循环\n\n固定夹具说明。\n',
        'docs/说明 文档.md': '# 中文说明 🚀\n\n含空格与多字节字符。\n',
        'src/模块/main.ts': 'export const 夹具名称 = "船舶循环";\n',
      },
    },
  };
}

/** 稳定 canonical JSON（递归按键排序），用于业务输入摘要。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: 不支持的输入类型 ${typeof value}`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 固定业务输入摘要：同一固定输入跨运行稳定。 */
export function computeBusinessInputDigest(input: P01BusinessInput = p01BusinessInput()): string {
  return sha256Hex(canonicalJson(input));
}

/* ------------------------------------------------------------------ *
 * 有界子进程（有限超时 + 退出核验，缺失工具显式失败）
 * ------------------------------------------------------------------ */

export type FixtureProcessErrorKind = 'timeout' | 'spawn';

export class FixtureProcessError extends Error {
  readonly kind: FixtureProcessErrorKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly code: string | undefined;

  constructor(
    kind: FixtureProcessErrorKind,
    command: string,
    args: readonly string[],
    message: string,
    code?: string,
  ) {
    super(message);
    this.name = 'FixtureProcessError';
    this.kind = kind;
    this.command = command;
    this.args = [...args];
    this.code = code;
  }
}

export interface CheckedProcessOptions {
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBufferBytes?: number;
}

export interface CheckedProcessResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 运行有界子进程并核验启动/超时：超时或无法启动（含 ENOENT 缺失工具）抛
 * FixtureProcessError（显式失败，绝不 skip）；正常与业务非零退出都返回结果，
 * 由调用方核对 `status`。
 */
export function runCheckedProcess(
  command: string,
  args: readonly string[],
  options: CheckedProcessOptions,
): CheckedProcessResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes ?? 16 * 1024 * 1024,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      throw new FixtureProcessError(
        'timeout',
        command,
        args,
        `子进程超时（${options.timeoutMs}ms）已被终止：${command}`,
        code,
      );
    }
    throw new FixtureProcessError(
      'spawn',
      command,
      args,
      `无法启动必需工具 ${command}：${result.error.message}`,
      code,
    );
  }
  return {
    command,
    args: [...args],
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/* ------------------------------------------------------------------ *
 * 夹具类型与实现
 * ------------------------------------------------------------------ */

export interface P01RepoSentinelSnapshot {
  readonly head: string;
  readonly statusPorcelain: string;
  /** 工作树（排除 .git）相对路径 -> SHA-256。 */
  readonly files: Readonly<Record<string, string>>;
  readonly sentinelSha256: string;
}

export interface P01EvidenceRef {
  /** 报告目录内相对路径（POSIX 分隔）。 */
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface P01FixtureTools {
  readonly gitVersion: string;
  readonly sqliteVersion: string;
}

export interface P01AcceptanceFixture {
  readonly root: string;
  readonly homeDir: string;
  readonly dataRoot: string;
  readonly repoDir: string;
  /** 独立报告目录（不在业务根内，业务清理后保留证据）。 */
  readonly reportDir: string;
  /** 根外哨兵文件（必须保持不变）。 */
  readonly outsideSentinelPath: string;
  readonly businessInput: P01BusinessInput;
  readonly businessInputDigest: string;
  readonly artifactBytes: Buffer;
  readonly artifactSha256: string;
  readonly tools: P01FixtureTools;
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
  readonly sourceRepoHead: string;
  /** 经公开装配入口打开同一数据根；登记受管应用，清理时统一关闭。 */
  openApplication(overrides?: Record<string, unknown>): Promise<CoreApplication>;
  snapshotSourceRepo(): P01RepoSentinelSnapshot;
  snapshotOutsideSentinel(): string;
  writeEvidence(relativePath: string, content: string | Uint8Array): P01EvidenceRef;
  /** 仅删除业务资源（关闭受管应用 + 删除业务根）；保留报告与根外哨兵。 */
  cleanup(): void;
  /** 删除独立报告目录。 */
  discardReport(): void;
  /** 清理业务根、报告目录与守卫目录；幂等。 */
  dispose(): void;
  readonly cleaned: boolean;
}

export interface P01FixtureOptions {
  readonly prefix?: string;
  readonly reportPrefix?: string;
  readonly outside?: readonly string[];
}

function hashDirectory(dir: string, skipNames: ReadonlySet<string>): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (prefix === '' && skipNames.has(entry.name)) {
        continue;
      }
      const child = join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child, relative);
      } else if (entry.isFile()) {
        result[relative] = sha256Hex(readFileSync(child));
      }
    }
  };
  walk(dir, '');
  return result;
}

function assertSafeEvidencePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new TypeError('证据相对路径必须是非空字符串');
  }
  if (relativePath.includes('\0') || relativePath.startsWith('/') || relativePath.includes('\\')) {
    throw new TypeError(`证据相对路径必须为 POSIX 相对路径：${relativePath}`);
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TypeError(`证据相对路径不允许空段/./..：${relativePath}`);
  }
  return segments.join('/');
}

export function createP01AcceptanceFixture(options: P01FixtureOptions = {}): P01AcceptanceFixture {
  const authoritativeTmp = tmpdir();
  const protectedPaths: readonly string[] = [REPO_ROOT, homedir(), ...(options.outside ?? [])];
  const sandbox = createTempSandbox(options.prefix ?? 'shiploop-p01-4-', {
    outside: [REPO_ROOT, homedir(), ...(options.outside ?? [])],
  });
  const root = sandbox.path;
  const homeDir = join(root, 'home');
  const dataRoot = join(root, 'data-root');
  const businessInput = p01BusinessInput();
  const repoDir = join(root, businessInput.repo.directoryName);
  const artifactBytes = Buffer.from(businessInput.artifact.content, 'utf-8');
  const artifactSha256 = sha256Hex(artifactBytes);
  const businessInputDigest = computeBusinessInputDigest(businessInput);
  const capabilityCatalog = createStaticRuntimeCapabilityCatalog([
    {
      runtimeId: 'pi',
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
    },
  ]);
  let clockValue = 1_900_000_000_000;
  const nowUtcMs = (): number => {
    clockValue += 1;
    return clockValue;
  };
  const apps = new Set<CoreApplication>();
  let cleaned = false;

  const removeBusinessRoot = (): void => {
    safeRemoveTempRoot(root, { authorizedRoot: authoritativeTmp, protectedPaths });
  };

  let reportDir: string | undefined;
  let guardDir: string | undefined;
  let outsideSentinelPath: string | undefined;
  let sourceRepoHead: string | undefined;
  let tools: P01FixtureTools | undefined;

  function closeApps(): void {
    for (const app of apps) {
      try {
        app.close();
      } catch {
        // 关闭失败不掩盖后续清理；继续关闭其余应用。
      }
    }
    apps.clear();
  }

  try {
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });

    // 必需工具探测：缺失即显式失败（不 skip）。
    const gitVersion = assertGitAvailable();
    const probePath = join(root, 'sqlite-probe.sqlite');
    const connection = openSqliteConnection(probePath);
    let sqliteVersion: string;
    try {
      const row = connection.database
        .prepare<[], { version: string }>('SELECT sqlite_version() AS version')
        .get();
      sqliteVersion = String(row?.version ?? '');
    } finally {
      connection.close();
    }
    rmSync(probePath, { force: true });
    if (!/^\d+\.\d+\.\d+$/.test(sqliteVersion)) {
      throw new Error(`SQLite 探测返回非法版本：${sqliteVersion}`);
    }
    tools = { gitVersion, sqliteVersion };

    // 真实 Git 仓库：Unicode/空格路径 + 固定文件 + 一次性注入身份 commit。
    const gitOptions = { home: homeDir } as const;
    initGitRepo(repoDir);
    for (const [relativePath, content] of Object.entries(businessInput.repo.files)) {
      const absolute = join(repoDir, ...relativePath.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf-8');
    }
    writeFileSync(
      join(repoDir, businessInput.repo.sentinelFileName),
      businessInput.repo.sentinelContent,
      'utf-8',
    );
    sourceRepoHead = commitAll(repoDir, businessInput.repo.commitMessage, gitOptions);

    // 根外哨兵：位于独立守卫目录，业务清理绝不能触碰。
    guardDir = createTempSandbox('shiploop-p01-4-guard-').path;
    outsideSentinelPath = join(guardDir, 'outside-sentinel.txt');
    writeFileSync(outsideSentinelPath, 'P01-4 outside sentinel — must remain unchanged\n', 'utf-8');

    // 独立报告目录：业务清理后保留证据。
    reportDir = createTempSandbox(options.reportPrefix ?? 'shiploop-p01-4-report-').path;
  } catch (error) {
    closeApps();
    try {
      removeBusinessRoot();
    } catch {
      // 准备失败时尽力收尾。
    }
    for (const dir of [reportDir, guardDir]) {
      if (dir !== undefined) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // 忽略二次清理失败。
        }
      }
    }
    throw error;
  }

  const resolvedReportDir = reportDir as string;
  const resolvedGuardDir = guardDir as string;
  const resolvedSentinel = outsideSentinelPath as string;
  const resolvedHead = sourceRepoHead as string;
  const resolvedTools = tools as P01FixtureTools;

  return {
    root,
    homeDir,
    dataRoot,
    repoDir,
    reportDir: resolvedReportDir,
    outsideSentinelPath: resolvedSentinel,
    businessInput,
    businessInputDigest,
    artifactBytes,
    artifactSha256,
    tools: resolvedTools,
    capabilityCatalog,
    sourceRepoHead: resolvedHead,

    async openApplication(overrides: Record<string, unknown> = {}): Promise<CoreApplication> {
      const app = await openCoreApplication({
        dataRoot,
        capabilityCatalog,
        nowUtcMs,
        ...overrides,
      });
      apps.add(app);
      return app;
    },

    snapshotSourceRepo(): P01RepoSentinelSnapshot {
      const gitOptions = { home: homeDir } as const;
      return {
        head: git(['rev-parse', 'HEAD'], repoDir, gitOptions).trim(),
        statusPorcelain: git(['status', '--porcelain'], repoDir, gitOptions),
        files: hashDirectory(repoDir, new Set(['.git'])),
        sentinelSha256: sha256Hex(readFileSync(join(repoDir, businessInput.repo.sentinelFileName))),
      };
    },

    snapshotOutsideSentinel(): string {
      return sha256Hex(readFileSync(resolvedSentinel));
    },

    writeEvidence(relativePath: string, content: string | Uint8Array): P01EvidenceRef {
      const normalized = assertSafeEvidencePath(relativePath);
      const absolute = join(resolvedReportDir, ...normalized.split('/'));
      if (!isInsideDirectory(absolute, resolvedReportDir)) {
        throw new TypeError(`证据路径越出报告目录：${relativePath}`);
      }
      mkdirSync(dirname(absolute), { recursive: true });
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
      writeFileSync(absolute, bytes);
      return { relativePath: normalized, sha256: sha256Hex(bytes), sizeBytes: bytes.length };
    },

    cleanup(): void {
      if (cleaned) {
        return;
      }
      closeApps();
      removeBusinessRoot();
      cleaned = true;
    },

    discardReport(): void {
      safeRemoveTempRoot(resolvedReportDir, { authorizedRoot: authoritativeTmp, protectedPaths });
    },

    dispose(): void {
      try {
        this.cleanup();
      } finally {
        for (const dir of [resolvedReportDir, resolvedGuardDir]) {
          try {
            safeRemoveTempRoot(dir, { authorizedRoot: authoritativeTmp, protectedPaths });
          } catch {
            // 报告/守卫目录清理失败不掩盖主流程；测试残留由系统临时目录回收。
          }
        }
      }
    },

    get cleaned(): boolean {
      return cleaned;
    },
  };
}

/** 同步/异步回调包裹：无论正常结束还是抛出都收尾（清理业务根、报告与守卫目录）。 */
export async function withP01AcceptanceFixture<T>(
  fn: (fixture: P01AcceptanceFixture) => T | Promise<T>,
  options: P01FixtureOptions = {},
): Promise<T> {
  const fixture = createP01AcceptanceFixture(options);
  try {
    return await fn(fixture);
  } finally {
    fixture.dispose();
  }
}
