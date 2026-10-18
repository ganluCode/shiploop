/**
 * P02-4 / F-011 `npm run accept:p02` 单次阶段验收控制器。
 * 开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 业务接口。
 *
 * 依据 `docs/p02-4-acceptance-contract.md`（F-001）§2.1/§2.5/§3.8 与 F-009 报告模块、
 * F-010 版本化配置实现：
 * - 前提检查复用 `resolveP02AcceptInvocation`（p02-config.ts）：配置 + CLI/env 参数在
 *   启动任何 Host/场景之前完成全部校验，失败 exitCode 1 且零副作用（不产生报告）；
 * - 一次运行按版本化配置的稳定场景清单自动串联：`npm run verify`（P02-ENG-VERIFY，
 *   verify 的锁文件预检/test/typecheck/build 实际执行）与 F-003~F-008 固定必需场景
 *   及 F-009 报告/聚合回归（各自真实测试入口，经 scripts/run-tests.ts 以本地锁定
 *   vitest 运行）——场景通过公共 CLI/Host 使用真实临时 Git/SQLite/进程，控制器不
 *   插业务行、不手工改 SQLite、不删锁；不依赖后序任务代码（F-012 约定入口未交付时
 *   该步骤明确 not_run/startup_failure，其余检查照常执行并保留证据）；
 * - 每一步都是**真实有界子进程**：显式 argv/cwd、不经 Shell 拼接、独立进程组、
 *   有限超时（单步与整体预算均为有限毫秒，整体预算先行耗尽按剩余预算超时）、
 *   输出有大小上限并记录截断/缺口；超时只对**自有子进程的进程组** SIGKILL 并以
 *   close 事件核验停止后才继续（未确认停止保留诊断并使阶段非零），绝不按进程名
 *   批量 kill、不触及用户仓库；
 * - 失败语义 fail-closed：步骤非零/信号退出 → 映射检查 fail；步骤超时 → not_run/
 *   timeout；启动失败/场景入口缺失 → not_run/startup_failure；失败即停止，未启动
 *   的必需步骤一律 not_run（绝不标为通过）；预期负例检查 pass 恰携带冻结断言集合
 *   （error/zeroStart/persistentState，由测试入口内的真实断言承载）；
 * - 夹具准备（P02-PHASE-FIXTURE 语义）：报告根校验、步骤计划接线、环境事实采集
 *   （git/tools/P02 Schema 版本交叉核对：settings/导出格式/SQLite 迁移/线消息/事件
 *   封套）任一失败 → 其余必需检查 not_run/startup_failure，仍写出报告保留已取得
 *   证据且阶段非零；
 * - 控制检查求值：P02-PHASE-NOT-RUN 由控制器以聚合探针复核（存在 missing_result
 *   即 fail）并与场景步骤结果取严格合并（fail-closed）；P02-PHASE-REPORT 由报告
 *   输入经严格 Schema 预校验 + 写出后整目录重验共同决定；证据在临时资源清理前以
 *   内存内容导出（证据 hash/size 可整目录重验）；
 * - 报告默认位置 artifacts/acceptance/p02/<run-id>/（report.json/summary.md/
 *   evidence/，F-009 写入器保证 run-id 目录不覆盖、敏感值统一脱敏、凭据形状扫描）；
 *   命令记录使用逻辑 argv/cwd（<node>/<repo>），不写入个人绝对路径；
 * - 退出码：全部必需检查 pass 且证据/报告核验成功才 0（computeP02PhaseExitCode）；
 *   任一 fail/not_run、证据缺失/损坏、报告写入失败均非零。`npm test` 不递归调用
 *   完整 accept:p02，也不调用任何付费模型。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接运行；
 * 不调用模型，不联网，除写报告目录外不修改受检仓库中的任何文件。
 */
import { spawn } from 'node:child_process';
import { OwnedProcessTree } from './owned-process-tree.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release as osRelease, type as osType } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import {
  P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS,
  P02_ACCEPT_SCRIPT_NAME,
  P02_ACCEPT_USAGE,
  resolveP02AcceptInvocation,
} from './p02-config.ts';
import type { P02AcceptanceConfig, P02AcceptOverrides, P02ResolvedInvocation } from './p02-config.ts';
import {
  P02_REQUIRED_CHECKS,
  P02_REQUIRED_CHECK_IDS,
  P02ReportError,
  aggregateP02CheckResults,
  assertValidRunId,
  buildP02AcceptanceReport,
  computeP02PhaseExitCode,
  generateP02RunId,
  redactSensitiveText,
  scanTextForCredentialShapes,
  verifyP02ReportDirectory,
  writeP02AcceptanceReport,
} from './p02-report.ts';
import type {
  P02Aggregation,
  P02AssertionKind,
  P02CheckResultInput,
  P02CommandRecord,
  P02EvidenceFileInput,
  P02EvidenceManifestEntry,
  P02NotRunReason,
  P02OutOfScopeEntry,
  P02WrittenReport,
} from './p02-report.ts';

/* ------------------------------------------------------------------ *
 * 常量与错误
 * ------------------------------------------------------------------ */

/** 环境事实采集子进程的统一有限超时。 */
const FACT_PROBE_TIMEOUT_MS = 30_000;
/** 超时 SIGKILL 后等待 close 事件的宽限期。 */
const KILL_GRACE_MS = 5_000;

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * F-012 的约定场景入口（P02-ENG-CLEAN-REPLAY）。未交付时控制器允许该入口缺席
 * （映射检查 not_run/startup_failure，阶段非零）；其余场景入口缺失一律按启动失败
 * 处理，绝不静默跳过。
 */
export const P02_PENDING_CLEAN_REPLAY_ENTRY = 'test/modules/acceptance/p02-4-clean-replay.test.ts';

export type P02AcceptErrorKind = 'invalid_config' | 'invalid_usage' | 'preparation_failed' | 'report_write_failed';

export class P02AcceptError extends Error {
  readonly kind: P02AcceptErrorKind;
  readonly detail?: string;

  constructor(kind: P02AcceptErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'P02AcceptError';
    this.kind = kind;
    this.detail = detail;
  }
}

function fail(kind: P02AcceptErrorKind, message: string, detail?: string): never {
  throw new P02AcceptError(kind, message, detail);
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 冻结定义查询：预期负例与必需断言集合（与 p02-report 同源）。 */
const DEFINITION_BY_ID: ReadonlyMap<
  string,
  { expectedNegative: boolean; requiredAssertions: readonly P02AssertionKind[] }
> = new Map(
  P02_REQUIRED_CHECKS.map((definition) => [
    definition.id,
    { expectedNegative: definition.expectedNegative, requiredAssertions: definition.requiredAssertions },
  ]),
);

/** 预期负例 pass 的证据说明：断言由测试入口内的真实断言承载。 */
export const P02_NEGATIVE_PASS_DETAIL =
  '预期负例：错误/零启动/持久状态断言由测试入口内的真实断言承载，步骤退出 0 表示冻结断言集合同时成立';

/* ------------------------------------------------------------------ *
 * 有界子进程（显式 argv/cwd、输出上限、超时只杀自有进程组并核验停止）
 * ------------------------------------------------------------------ */

export interface P02BoundedRunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface P02BoundedRunOutcome {
  readonly kind: 'exit' | 'signal' | 'timeout' | 'spawn_error';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly spawnError: string | null;
  /** 超时后已核验进程停止（收到 close）；false 表示宽限期耗尽仍未确认。 */
  readonly stoppedVerified: boolean;
}

interface CappedCollector {
  push(chunk: Buffer): void;
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

function createCappedCollector(limit: number): CappedCollector {
  let total = 0;
  let kept = 0;
  const chunks: Buffer[] = [];
  return {
    push(chunk: Buffer): void {
      total += chunk.length;
      if (kept < limit) {
        const remaining = limit - kept;
        const slice = chunk.subarray(0, remaining);
        chunks.push(slice);
        kept += slice.length;
      }
    },
    get text(): string {
      return Buffer.concat(chunks).toString('utf-8');
    },
    get truncated(): boolean {
      return total > limit;
    },
    get bytes(): number {
      return total;
    },
  };
}

/**
 * 以独立进程组运行命令（显式 argv，不经 Shell 拼接），有限超时；
 * stdout/stderr 分别按 maxOutputBytes 截断保留并记录原始字节数；
 * 超时只对本控制器自有子进程的进程组 SIGKILL（负 pid，绝不按进程名批量
 * kill），等待 close 事件核验进程停止（宽限期后兜底并标记未确认）。
 */
export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: P02BoundedRunOptions,
): Promise<P02BoundedRunOutcome> {
  return new Promise((resolveOutcome) => {
    const started = Date.now();
    const stdout = createCappedCollector(options.maxOutputBytes);
    const stderr = createCappedCollector(options.maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let processTree: OwnedProcessTree | undefined;

    const settle = (outcome: P02BoundedRunOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
      }
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
      }
      void (processTree?.finish(timedOut || outcome.exitCode !== 0) ?? Promise.resolve(true)).then((stopped) => {
        resolveOutcome({ ...outcome, stoppedVerified: outcome.stoppedVerified && stopped });
      });
    };

    const buildOutcome = (
      kind: P02BoundedRunOutcome['kind'],
      exitCode: number | null,
      signal: string | null,
      stoppedVerified: boolean,
    ): P02BoundedRunOutcome => ({
      kind,
      exitCode,
      signal,
      durationMs: Date.now() - started,
      timedOut,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      spawnError: spawnError !== null ? spawnError.message : null,
      stoppedVerified,
    });

    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      spawnError = error as Error;
      settle(buildOutcome('spawn_error', null, null, true));
      return;
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      processTree?.kill();
      if (child.pid !== undefined) {
        try {
          // 负 pid 只杀本控制器启动的进程组（含孙进程），随后等待 close 核验停止。
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // 子进程已退出，无需处理。
          }
        }
      }
      graceTimer = setTimeout(() => {
        settle(buildOutcome('timeout', null, null, false));
      }, KILL_GRACE_MS);
      graceTimer.unref();
    }, options.timeoutMs);
    processTree = new OwnedProcessTree(child.pid);

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        settle(buildOutcome('timeout', null, signal, true));
        return;
      }
      if (spawnError !== null) {
        settle(buildOutcome('spawn_error', null, null, true));
        return;
      }
      if (signal !== null) {
        settle(buildOutcome('signal', null, signal, true));
        return;
      }
      settle(buildOutcome('exit', code ?? 1, null, true));
    });
  });
}

/* ------------------------------------------------------------------ *
 * 执行步骤计划（版本化配置的稳定场景清单 → 真实有界子进程步骤）
 * ------------------------------------------------------------------ */

export interface P02AcceptanceStep {
  readonly stepId: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** 本步骤承接的必需检查 ID（顺序固定）。 */
  readonly checkIds: readonly string[];
  readonly timeoutMs: number;
  /** 附加环境变量（叠加在控制器环境之上）。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 生产步骤携带的场景入口（test/*.test.ts）；启动前核验存在，缺失=启动失败。 */
  readonly entryFile?: string;
}

interface NpmInvocation {
  readonly command: string;
  readonly argsPrefix: readonly string[];
}

/** 与 scripts/verify.ts 一致：优先 npm_execpath 指定的当前 npm，否则回退 PATH 上的 npm。 */
function resolveNpm(env: NodeJS.ProcessEnv): NpmInvocation {
  const execPath = env.npm_execpath;
  if (typeof execPath === 'string' && execPath.endsWith('.js') && existsSync(execPath)) {
    return { command: process.execPath, argsPrefix: [execPath] };
  }
  return { command: 'npm', argsPrefix: [] };
}

export interface P02ProductionStepOptions {
  readonly stepTimeoutMs?: number;
  readonly verifyTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * 生产步骤计划：按版本化配置的稳定场景清单构建（verify 命令步骤 + 各测试场景
 * 步骤，经 scripts/run-tests.ts 以本地锁定 vitest 运行真实入口）。
 * 步骤映射必须与冻结必需检查清单逐项一致（顺序固定），否则视为接线错误拒绝。
 */
export function buildP02ProductionSteps(
  config: P02AcceptanceConfig,
  options: P02ProductionStepOptions = {},
): P02AcceptanceStep[] {
  const env = options.env ?? process.env;
  const npm = resolveNpm(env);
  const scenarioTimeoutMs = options.stepTimeoutMs ?? config.timeouts.scenarioMs;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? config.timeouts.verifyMs;

  const steps: P02AcceptanceStep[] = [];
  for (const scenario of config.scenarios) {
    if (scenario.kind === 'command') {
      steps.push({
        stepId: scenario.id,
        label: `${scenario.entry}（锁文件预检 + test/typecheck/build 实际执行）`,
        command: npm.command,
        args: [...npm.argsPrefix, 'run', 'verify'],
        checkIds: [...scenario.checkIds],
        timeoutMs: verifyTimeoutMs,
        env: {
          [P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS]: String(verifyTimeoutMs),
          SHIPLOOP_TEST_RUN_TIMEOUT_MS: String(verifyTimeoutMs),
        },
      });
    } else {
      steps.push({
        stepId: scenario.id,
        label: `${scenario.entry}（真实临时 Git/SQLite/进程，经公共 CLI/Host）`,
        command: process.execPath,
        args: ['scripts/run-tests.ts', scenario.entry],
        checkIds: [...scenario.checkIds],
        timeoutMs: scenarioTimeoutMs,
        // 子启动器的默认十分钟不能截断阶段已批准的有限场景预算。
        env: { SHIPLOOP_TEST_RUN_TIMEOUT_MS: String(scenarioTimeoutMs) },
        entryFile: scenario.entry,
      });
    }
  }

  // 接线自检：步骤映射必须与冻结必需检查清单完全一致（fail-closed）。
  const mapped = steps.flatMap((step) => step.checkIds);
  if (
    mapped.length !== P02_REQUIRED_CHECK_IDS.length ||
    mapped.some((checkId, index) => checkId !== P02_REQUIRED_CHECK_IDS[index])
  ) {
    fail(
      'invalid_config',
      '步骤计划与冻结必需检查清单不一致（须恰好覆盖全部必需检查各一次且顺序一致）',
    );
  }
  return steps;
}

/* ------------------------------------------------------------------ *
 * 环境事实采集（git/tools/P02 Schema 版本交叉核对/输入计划摘要）
 * ------------------------------------------------------------------ */

export interface P02EnvironmentFacts {
  readonly git: {
    readonly commit: string;
    readonly worktree: 'clean' | 'dirty';
    readonly branch: string | null;
    readonly codeSha256: string;
  };
  readonly platform: { readonly system: string; readonly release: string; readonly arch: string };
  readonly tools: {
    readonly node: string;
    readonly npm: string;
    readonly git: string;
    readonly sqlite: string;
    readonly betterSqlite3: string;
    readonly drizzleOrm: string;
  };
  readonly schemaVersions: P02AcceptanceConfig['schemaVersions'];
  readonly planDigestSha256: string;
}

/** 只读 Git 子进程的最小确定环境：不读取用户全局/系统 Git 配置。 */
function gitProbeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function probe(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  label: string,
): Promise<string> {
  const outcome = await runBoundedProcess(command, args, {
    cwd,
    ...(env !== undefined ? { env } : {}),
    timeoutMs: FACT_PROBE_TIMEOUT_MS,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (outcome.kind !== 'exit' || outcome.exitCode !== 0) {
    fail(
      'preparation_failed',
      `环境事实采集失败（${label}）：${outcome.kind}${outcome.exitCode !== null ? `/${outcome.exitCode}` : ''}${outcome.spawnError !== null ? ` ${outcome.spawnError}` : ''}`,
      label,
    );
  }
  return outcome.stdout.trim();
}

/** 从源码文本交叉核对配置声明的 P02 Schema 版本（防文档/配置与实现漂移）。 */
function crossCheckP02SchemaVersions(repoRoot: string, config: P02AcceptanceConfig): void {
  const readSource = (relativePath: string): string => {
    const absolute = resolve(repoRoot, relativePath);
    if (!existsSync(absolute)) {
      fail('preparation_failed', `Schema 版本交叉核对来源不存在：${relativePath}`, relativePath);
    }
    return readFileSync(absolute, 'utf-8');
  };
  const settingsSource = readSource('packages/core/src/ports/settings-schema.ts');
  const settingsMatch = /export const SETTINGS_SCHEMA_VERSION = (\d+);/.exec(settingsSource);
  if (settingsMatch === null || Number(settingsMatch[1]) !== config.schemaVersions.settingsSchema) {
    fail(
      'preparation_failed',
      `SETTINGS_SCHEMA_VERSION 与配置不一致（配置=${config.schemaVersions.settingsSchema}）`,
      'settings-schema',
    );
  }
  const exportMatch = /export const SETTINGS_EXPORT_FORMAT_VERSION = (\d+);/.exec(settingsSource);
  if (exportMatch === null || Number(exportMatch[1]) !== config.schemaVersions.settingsExportFormat) {
    fail(
      'preparation_failed',
      `SETTINGS_EXPORT_FORMAT_VERSION 与配置不一致（配置=${config.schemaVersions.settingsExportFormat}）`,
      'settings-export',
    );
  }
  const migrationsSource = readSource('packages/core/src/adapters/sqlite/migrations.ts');
  const declarationIndex = migrationsSource.indexOf('export const SQLITE_MIGRATIONS');
  if (declarationIndex < 0) {
    fail('preparation_failed', 'SQLITE_MIGRATIONS 声明未找到', 'sqlite-migrations');
  }
  const declared = [...migrationsSource.slice(declarationIndex).matchAll(/version: (\d+),/g)].map(
    (match) => Number(match[1]),
  );
  const expectedMigrations = config.schemaVersions.sqliteMigrations;
  if (
    declared.length !== expectedMigrations.length ||
    declared.some((version, index) => version !== expectedMigrations[index])
  ) {
    fail(
      'preparation_failed',
      `SQLITE_MIGRATIONS 版本与配置不一致（源码=[${declared.join(',')}] 配置=[${expectedMigrations.join(',')}]）`,
      'sqlite-migrations',
    );
  }
  const commandsSource = readSource('packages/core/src/ports/commands.ts');
  const wireMatch = /export const WIRE_MESSAGE_SCHEMA_VERSION = (\d+) as const;/.exec(commandsSource);
  if (wireMatch === null || Number(wireMatch[1]) !== config.schemaVersions.applicationWireSchema) {
    fail(
      'preparation_failed',
      `WIRE_MESSAGE_SCHEMA_VERSION 与配置不一致（配置=${config.schemaVersions.applicationWireSchema}）`,
      'application-wire-schema',
    );
  }
  const eventsSource = readSource('packages/core/src/ports/events.ts');
  const envelopeMatch = /export const PUBLIC_EVENT_SCHEMA_VERSION = (\d+) as const;/.exec(eventsSource);
  if (envelopeMatch === null || Number(envelopeMatch[1]) !== config.schemaVersions.eventEnvelopeSchema) {
    fail(
      'preparation_failed',
      `PUBLIC_EVENT_SCHEMA_VERSION 与配置不一致（配置=${config.schemaVersions.eventEnvelopeSchema}）`,
      'event-envelope-schema',
    );
  }
}

/**
 * 采集报告所需的真实环境事实：受测 commit/工作树/分支、代码摘要、平台、
 * 实际 Node/npm/Git/SQLite/驱动/ORM 版本、P02 Schema 版本交叉核对与输入计划摘要。
 * 任一探测失败即 preparation_failed（必要工具/驱动缺失显式失败而非 skip）。
 */
export async function collectP02EnvironmentFacts(
  repoRoot: string,
  config: P02AcceptanceConfig,
): Promise<P02EnvironmentFacts> {
  const gitEnv = gitProbeEnv();
  const commit = await probe('git', ['rev-parse', 'HEAD'], repoRoot, gitEnv, 'git.commit');
  if (!HEX_40.test(commit)) {
    fail('preparation_failed', `git rev-parse HEAD 返回非法 commit：${commit}`, 'git.commit');
  }
  const status = await probe('git', ['status', '--porcelain'], repoRoot, gitEnv, 'git.worktree');
  const branchRaw = await probe(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoRoot,
    gitEnv,
    'git.branch',
  );
  const treeListing = await probe('git', ['ls-tree', '-r', 'HEAD'], repoRoot, gitEnv, 'git.codeSha256');
  if (treeListing.length === 0) {
    fail('preparation_failed', 'git ls-tree -r HEAD 为空（无已提交代码）', 'git.codeSha256');
  }

  const npm = resolveNpm(process.env);
  const npmVersion = await probe(
    npm.command,
    [...npm.argsPrefix, '--version'],
    repoRoot,
    undefined,
    'tools.npm',
  );
  const gitVersion = await probe('git', ['--version'], repoRoot, gitEnv, 'tools.git');
  if (!/^git version \S+/.test(gitVersion)) {
    fail('preparation_failed', `git --version 返回非法输出：${gitVersion}`, 'tools.git');
  }

  // SQLite 驱动真实探测（经 packages/core 声明的 better-sqlite3 解析）。
  const sqliteProbeScript =
    "import { createRequire } from 'node:module';\n" +
    `const requireFromCore = createRequire(${JSON.stringify(resolve(repoRoot, 'packages/core/package.json'))});\n` +
    "const Database = requireFromCore('better-sqlite3');\n" +
    "const db = new Database(':memory:');\n" +
    "const row = db.prepare('SELECT sqlite_version() AS v').get();\n" +
    'db.close();\n' +
    'process.stdout.write(String(row.v));\n';
  const sqliteVersion = await probe(
    process.execPath,
    ['--input-type=module', '-e', sqliteProbeScript],
    repoRoot,
    undefined,
    'tools.sqlite',
  );
  if (!/^\d+\.\d+\.\d+$/.test(sqliteVersion)) {
    fail('preparation_failed', `SQLite 探测返回非法版本：${sqliteVersion}`, 'tools.sqlite');
  }

  const requireFromCore = createRequire(resolve(repoRoot, 'packages/core/package.json'));
  const readDependencyVersion = (name: string, label: string): string => {
    // 部分包（如 drizzle-orm）的 exports 不暴露 ./package.json：先解析入口，
    // 再向上查找携带同名 name 的 package.json。
    let entryPath: string;
    try {
      entryPath = requireFromCore.resolve(name);
    } catch (error) {
      fail('preparation_failed', `依赖 ${name} 无法解析：${(error as Error).message}`, label);
    }
    let directory = dirname(entryPath as string);
    for (let depth = 0; depth < 8; depth += 1) {
      const manifestPath = resolve(directory, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name === name) {
          if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
            fail('preparation_failed', `依赖 ${name} 缺少有效版本`, label);
          }
          return manifest.version;
        }
      }
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
    fail('preparation_failed', `依赖 ${name} 的包根 package.json 未找到`, label);
  };

  crossCheckP02SchemaVersions(repoRoot, config);

  const contractPath = resolve(repoRoot, config.plan.contractDoc);
  if (!existsSync(contractPath)) {
    fail('preparation_failed', `验收契约文档不存在：${config.plan.contractDoc}`, 'plan.digest');
  }
  const planDigestSha256 = sha256Hex(readFileSync(contractPath, 'utf-8'));

  return {
    git: {
      commit,
      worktree: status.length === 0 ? 'clean' : 'dirty',
      branch: branchRaw === 'HEAD' ? null : branchRaw,
      codeSha256: sha256Hex(treeListing),
    },
    platform: { system: osType(), release: osRelease(), arch: arch() },
    tools: {
      node: process.version,
      npm: npmVersion,
      git: gitVersion,
      sqlite: sqliteVersion,
      betterSqlite3: readDependencyVersion('better-sqlite3', 'tools.betterSqlite3'),
      drizzleOrm: readDependencyVersion('drizzle-orm', 'tools.drizzleOrm'),
    },
    schemaVersions: {
      settingsSchema: config.schemaVersions.settingsSchema,
      settingsExportFormat: config.schemaVersions.settingsExportFormat,
      sqliteMigrations: [...config.schemaVersions.sqliteMigrations],
      applicationWireSchema: config.schemaVersions.applicationWireSchema,
      eventEnvelopeSchema: config.schemaVersions.eventEnvelopeSchema,
    },
    planDigestSha256,
  };
}

/** 夹具准备失败时的显式占位事实（报告仍需通过严格 Schema；限制中明确标注）。 */
function fallbackP02Facts(config: P02AcceptanceConfig): P02EnvironmentFacts {
  return {
    git: {
      commit: '0'.repeat(40),
      worktree: 'dirty',
      branch: null,
      codeSha256: '0'.repeat(64),
    },
    platform: { system: osType(), release: osRelease(), arch: arch() },
    tools: {
      node: process.version,
      npm: 'unknown',
      git: 'unknown',
      sqlite: 'unknown',
      betterSqlite3: 'unknown',
      drizzleOrm: 'unknown',
    },
    schemaVersions: {
      settingsSchema: config.schemaVersions.settingsSchema,
      settingsExportFormat: config.schemaVersions.settingsExportFormat,
      sqliteMigrations: [...config.schemaVersions.sqliteMigrations],
      applicationWireSchema: config.schemaVersions.applicationWireSchema,
      eventEnvelopeSchema: config.schemaVersions.eventEnvelopeSchema,
    },
    planDigestSha256: '0'.repeat(64),
  };
}

/* ------------------------------------------------------------------ *
 * 验收控制器
 * ------------------------------------------------------------------ */

export interface P02AcceptancePrepareContext {
  readonly runId: string;
  readonly reportRoot: string;
  readonly repoRoot: string;
  readonly facts: P02EnvironmentFacts;
  readonly steps: readonly P02AcceptanceStep[];
}

export interface P02AcceptanceRunOptions {
  readonly repoRoot: string;
  readonly config: P02AcceptanceConfig;
  readonly overrides?: P02AcceptOverrides;
  /** 步骤计划注入（默认生产计划）；测试以真实有界子进程替换为快速步骤。 */
  readonly steps?: readonly P02AcceptanceStep[];
  readonly env?: NodeJS.ProcessEnv;
  /** 需要脱敏的敏感值（合成凭据等），透传 F-009 写入器统一脱敏。 */
  readonly sensitiveValues?: readonly string[];
  readonly nowUtc?: () => Date;
  readonly runIdSuffix?: string;
  /** 准备期注入钩子（测试注入准备错误）。 */
  readonly prepare?: (context: P02AcceptancePrepareContext) => void;
  /** 环境事实采集注入（默认真实采集）。 */
  readonly collectFacts?: (
    repoRoot: string,
    config: P02AcceptanceConfig,
  ) => Promise<P02EnvironmentFacts>;
  /**
   * 报告写出后、整目录重验前的注入点（仅用于验收工具故障注入，如证据损坏）；
   * 生产路径不使用。
   */
  readonly afterReportWrite?: (runDir: string) => void;
  readonly log?: (message: string) => void;
}

export interface P02AcceptanceRunResult {
  readonly runId: string;
  readonly runDir: string | null;
  readonly exitCode: number;
  readonly conclusion: 'pass' | 'fail' | null;
  readonly counts: { pass: number; fail: number; not_run: number; total: number } | null;
  readonly problems: readonly string[];
  readonly reportWritten: boolean;
  readonly evidenceOk: boolean;
  readonly written: P02WrittenReport | null;
}

/** 阶段外能力：标记 not_run/unsupported，不计入必需项通过数（契约 §2.5）。 */
const P02_OUT_OF_SCOPE: readonly P02OutOfScopeEntry[] = [
  {
    id: 'P02-OOS-MODEL-LIVE',
    capability: 'Runtime/Pi SDK 模型 Live 调用',
    status: 'not_run',
    note: 'P02 无模型调用；本阶段不运行也不计入必需项通过数',
  },
  {
    id: 'P02-OOS-WEB-CLIENT',
    capability: '托管 Web/Electron 客户端',
    status: 'not_run',
    note: '客户端按路线后续建设，本阶段仅 CLI/Host',
  },
  {
    id: 'P02-OOS-NON-MACOS',
    capability: 'Windows/WSL/Linux 平台验收',
    status: 'not_run',
    note: '正式验收限 macOS；其他平台另行验收',
  },
  {
    id: 'P02-OOS-STRONG-SANDBOX',
    capability: '强 OS 沙箱',
    status: 'unsupported',
    note: '首版为可信项目模式，强沙箱按路线后续建设',
  },
];

const P02_KNOWN_LIMITATIONS: readonly string[] = [
  '正式验收平台限 macOS；Windows/WSL/Linux 未验收。',
  '可信项目模式不等于强 OS 沙箱；Pi 默认工具无强 OS 沙箱。',
  `P02-ENG-CLEAN-REPLAY 由 ${P02_PENDING_CLEAN_REPLAY_ENTRY} 承接（F-012 交付）：入口未交付时该检查 not_run/startup_failure，阶段退出码非零。`,
  '场景步骤经 scripts/run-tests.ts 以本地锁定 vitest 运行真实测试入口；verify 步骤先行完成锁文件预检/test/typecheck/build。',
];

/** 逻辑 argv/cwd 映射：报告与证据不写入个人绝对路径。 */
function logicalArg(value: string, repoRoot: string): string {
  if (scanTextForCredentialShapes(value).length > 0) {
    return `[credential-shaped argument redacted; sha256=${createHash('sha256').update(value).digest('hex')}]`;
  }
  if (value === process.execPath) {
    return '<node>';
  }
  if (isAbsolute(value)) {
    const rootWithSep = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
    if (value === repoRoot) {
      return '<repo>';
    }
    if (value.startsWith(rootWithSep)) {
      return `<repo>/${value.slice(rootWithSep.length).split(sep).join('/')}`;
    }
    const npmExecPath = process.env.npm_execpath;
    if (typeof npmExecPath === 'string' && value === npmExecPath) {
      return '<npm-cli>';
    }
    return '<abs>';
  }
  return value;
}

function renderStepLog(
  step: P02AcceptanceStep,
  outcome: P02BoundedRunOutcome,
  repoRoot: string,
  maxOutputBytes: number,
): string {
  const lines: string[] = [];
  lines.push('# accept:p02 step log');
  lines.push(`step: ${step.stepId}`);
  lines.push(`label: ${step.label}`);
  lines.push(`argv: ${[step.command, ...step.args].map((arg) => logicalArg(arg, repoRoot)).join(' ')}`);
  lines.push('cwd: <repo>');
  lines.push(`timeout_ms: ${step.timeoutMs}`);
  lines.push(
    `outcome: ${outcome.kind}${outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ''}${outcome.signal !== null ? ` (signal ${outcome.signal})` : ''}${outcome.spawnError !== null ? ` (${outcome.spawnError})` : ''}`,
  );
  lines.push(`duration_ms: ${outcome.durationMs}`);
  lines.push(`stopped_verified: ${outcome.stoppedVerified}`);
  lines.push(
    `stdout_bytes: ${outcome.stdoutBytes}${outcome.stdoutTruncated ? `（超出上限 ${maxOutputBytes}，已截断，仅保留前段）` : ''}`,
  );
  lines.push(
    `stderr_bytes: ${outcome.stderrBytes}${outcome.stderrTruncated ? `（超出上限 ${maxOutputBytes}，已截断，仅保留前段）` : ''}`,
  );
  lines.push('--- stdout ---');
  lines.push(redactCommandOutput(outcome.stdout));
  if (outcome.stdoutTruncated) {
    lines.push(`[output truncated: kept first ${maxOutputBytes} of ${outcome.stdoutBytes} bytes]`);
  }
  lines.push('--- stderr ---');
  lines.push(redactCommandOutput(outcome.stderr));
  if (outcome.stderrTruncated) {
    lines.push(`[output truncated: kept first ${maxOutputBytes} of ${outcome.stderrBytes} bytes]`);
  }
  return `${lines.join('\n')}\n`;
}

// Omit the whole affected stream: a credential value can span multiple lines.
// The report still records outcome, byte counts and a digest, and keeps its fail-closed scanner.
function redactCommandOutput(text: string): string {
  if (scanTextForCredentialShapes(text).length === 0) return text;
  const failedFiles = [...new Set([...stripVTControlCharacters(text).matchAll(/^\s*FAIL\s+(test\/[A-Za-z0-9._/-]+\.(?:test|spec)\.ts)(?:\s|$)/gm)].map((match) => match[1]))];
  return [`[credential-shaped output redacted; sha256=${createHash('sha256').update(text).digest('hex')}]`,
    ...failedFiles.map((path) => `failed_test_file: ${path}`)].join('\n');
}

/* ---------------- 控制检查求值（P02-PHASE-*） ---------------- */

/** 控制检查的控制器侧求值结果（与场景步骤结果做 fail-closed 合并）。 */
export interface P02ControlEvaluation {
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

/**
 * P02-PHASE-NOT-RUN 控制求值：聚合中存在 missing_result（未提交结果的必需检查）
 * 即 fail；全部必需检查均已提交结果（未启动/超时/被跳过项显式分类为 not_run）才 pass。
 */
export function evaluateP02NotRunControl(aggregation: P02Aggregation): P02ControlEvaluation {
  const missing = aggregation.checks
    .filter((check) => check.status === 'not_run' && check.notRunReason === 'missing_result')
    .map((check) => check.id);
  if (missing.length > 0) {
    return { status: 'fail', detail: `存在未提交结果的必需检查：${missing.join(', ')}` };
  }
  return {
    status: 'pass',
    detail: '全部必需检查均已提交结果；未提交/启动失败/超时/被跳过项均显式分类为 not_run',
  };
}

/**
 * 控制检查合并（fail-closed）：场景步骤结果非 pass 时保留原状态（not_run/fail
 * 如实传播）；步骤 pass 但控制器侧求值 fail 时降级为 fail；两者均 pass 才 pass。
 */
function combineControlCheck(
  checkId: string,
  existing: P02CheckResultInput | undefined,
  own: P02ControlEvaluation,
): P02CheckResultInput {
  if (existing === undefined) {
    return { checkId, status: 'fail', detail: `控制检查缺少场景步骤结果；${own.detail}` };
  }
  if (existing.status !== 'pass') {
    if (own.status === 'fail') {
      const detail = existing.detail === undefined ? own.detail : `${existing.detail}；${own.detail}`;
      return { ...existing, detail };
    }
    return existing;
  }
  if (own.status === 'fail') {
    return { ...existing, status: 'fail', detail: own.detail };
  }
  const detail = existing.detail === undefined ? own.detail : `${existing.detail}；${own.detail}`;
  return { ...existing, detail };
}

/**
 * 执行一次 P02 阶段验收：前提检查（配置/参数，由 CLI 入口的
 * resolveP02AcceptInvocation 先行完成）→ 夹具准备 → 逐步执行（fail-fast，未启动
 * 标 not_run）→ 控制检查求值 → 报告写出与整目录重验 → 退出码。
 * 证据在任何清理之前以内存内容导出到报告目录；报告写入失败同样非零且诊断明确。
 */
export async function runP02Acceptance(
  options: P02AcceptanceRunOptions,
): Promise<P02AcceptanceRunResult> {
  const { repoRoot, config } = options;
  const baseEnv = options.env ?? process.env;
  const nowUtc = options.nowUtc ?? (() => new Date());
  const log = options.log ?? ((): void => undefined);
  const problems: string[] = [];
  const commands: P02CommandRecord[] = [];
  const evidenceFiles: P02EvidenceFileInput[] = [];
  const results = new Map<string, P02CheckResultInput>();
  const limitations = [...P02_KNOWN_LIMITATIONS];

  // run-id：覆盖值非法属于用法错误（拒绝，不产生报告）。
  let runId: string;
  try {
    runId = options.overrides?.runId ?? generateP02RunId(nowUtc(), options.runIdSuffix);
    assertValidRunId(runId);
  } catch (error) {
    fail(
      'invalid_usage',
      `run-id 非法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const reportRootAbs =
    options.overrides?.reportDir !== undefined
      ? isAbsolute(options.overrides.reportDir)
        ? options.overrides.reportDir
        : resolve(repoRoot, options.overrides.reportDir)
      : resolve(repoRoot, config.reportRoot);
  const overallDeadline = Date.now() + config.timeouts.overallMs;

  /* ---------------- 夹具准备（P02-PHASE-FIXTURE 语义） ---------------- */
  let facts: P02EnvironmentFacts;
  let steps: readonly P02AcceptanceStep[] = [];
  let fixtureFailure: string | null = null;
  try {
    if (existsSync(reportRootAbs) && !statSync(reportRootAbs).isDirectory()) {
      fail('preparation_failed', `报告根不是目录：${reportRootAbs}`);
    }
    steps =
      options.steps ??
      buildP02ProductionSteps(config, {
        ...(options.overrides?.stepTimeoutMs !== undefined
          ? { stepTimeoutMs: options.overrides.stepTimeoutMs }
          : {}),
        ...(options.overrides?.verifyTimeoutMs !== undefined
          ? { verifyTimeoutMs: options.overrides.verifyTimeoutMs }
          : {}),
        env: baseEnv,
      });
    facts = await (options.collectFacts ?? collectP02EnvironmentFacts)(repoRoot, config);
    options.prepare?.({ runId, reportRoot: reportRootAbs, repoRoot, facts, steps });
  } catch (error) {
    fixtureFailure =
      error instanceof P02AcceptError || error instanceof P02ReportError
        ? error.message
        : `夹具准备异常：${(error as Error).message}`;
    facts = fallbackP02Facts(config);
    limitations.push('夹具准备/环境事实采集失败：git/tools/摘要字段为显式占位，详见 P02-PHASE-FIXTURE。');
  }

  const overridesSnapshot = {
    ...(options.overrides ?? {}),
    ...(options.overrides?.reportDir !== undefined ? { reportDir: '<report-root>' } : {}),
  };
  evidenceFiles.push({
    path: 'evidence/config.json',
    content: `${JSON.stringify({ config, overrides: overridesSnapshot }, null, 2)}\n`,
    checkId: 'P02-PHASE-FIXTURE',
  });
  evidenceFiles.push({
    path: 'evidence/environment.json',
    content: `${JSON.stringify(facts, null, 2)}\n`,
    checkId: 'P02-PHASE-FIXTURE',
  });

  /* ---------------- 步骤执行（fail-fast） ---------------- */
  if (fixtureFailure !== null) {
    results.set('P02-PHASE-FIXTURE', {
      checkId: 'P02-PHASE-FIXTURE',
      status: 'fail',
      detail: fixtureFailure,
      evidenceRefs: ['evidence/config.json', 'evidence/environment.json'],
    });
    for (const definition of P02_REQUIRED_CHECKS) {
      if (definition.id === 'P02-PHASE-FIXTURE') {
        continue;
      }
      results.set(definition.id, {
        checkId: definition.id,
        status: 'not_run',
        notRunReason: 'startup_failure',
        detail: '夹具准备失败，依赖检查未启动',
      });
    }
    log(`${P02_ACCEPT_SCRIPT_NAME}: FIXTURE FAIL ${fixtureFailure}`);
  } else {
    let halt: { readonly reason: P02NotRunReason; readonly detail: string } | null = null;
    for (const [index, step] of steps.entries()) {
      const markChecks = (
        status: 'pass' | 'fail' | 'not_run',
        notRunReason: P02NotRunReason | null,
        detail: string,
      ): void => {
        for (const checkId of step.checkIds) {
          results.set(checkId, {
            checkId,
            status,
            ...(notRunReason !== null ? { notRunReason } : {}),
            detail,
          });
        }
      };

      if (halt !== null) {
        markChecks('not_run', halt.reason, halt.detail);
        continue;
      }
      const remainingMs = overallDeadline - Date.now();
      if (remainingMs <= 0) {
        halt = { reason: 'startup_failure', detail: '阶段整体时间预算耗尽，步骤未启动' };
        markChecks('not_run', halt.reason, halt.detail);
        continue;
      }
      const timeoutMs = Math.min(step.timeoutMs, remainingMs);

      // 场景入口存在性核验（启动前）：缺失按启动失败处理（后继任务约定入口
      // 未交付时不伪装为通过），该步骤的检查明确 not_run/startup_failure。
      if (step.entryFile !== undefined && !existsSync(resolve(repoRoot, step.entryFile))) {
        const detail = `步骤场景入口不存在：${step.entryFile}（约定入口未交付或被移动，不伪装为通过）`;
        for (const checkId of step.checkIds) {
          results.set(checkId, {
            checkId,
            status: 'not_run',
            notRunReason: 'startup_failure',
            detail,
            evidenceRefs: [`evidence/checks/${checkId}.json`],
          });
          evidenceFiles.push({
            path: `evidence/checks/${checkId}.json`,
            content: `${JSON.stringify(
              {
                checkId,
                status: 'not_run',
                notRunReason: 'startup_failure',
                stepId: step.stepId,
                entryFile: step.entryFile,
                entryExists: false,
                detail,
              },
              null,
              2,
            )}\n`,
            checkId,
          });
        }
        halt = { reason: 'startup_failure', detail: `前序步骤 ${step.stepId} 场景入口缺失，未启动` };
        log(`${P02_ACCEPT_SCRIPT_NAME}: STEP [${index + 1}/${steps.length}] ENTRY MISSING ${step.entryFile}`);
        continue;
      }

      log(`${P02_ACCEPT_SCRIPT_NAME}: STEP [${index + 1}/${steps.length}] RUN ${step.label}`);
      const outcome = await runBoundedProcess(step.command, step.args, {
        cwd: repoRoot,
        env: { ...baseEnv, ...step.env },
        timeoutMs,
        maxOutputBytes: config.maxCommandOutputBytes,
      });
      if (!outcome.stoppedVerified) {
        problems.push(`步骤 ${step.stepId} 超时后未能在宽限期内核验进程停止`);
      }
      commands.push({
        label: step.label,
        argv: [step.command, ...step.args].map((arg) => logicalArg(arg, repoRoot)),
        cwd: '<repo>',
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        ...(outcome.timedOut ? { timedOut: true } : {}),
      });
      const logPath = `evidence/commands/${String(index + 1).padStart(2, '0')}-${step.stepId}.log`;
      evidenceFiles.push({
        path: logPath,
        content: renderStepLog(step, outcome, repoRoot, config.maxCommandOutputBytes),
        checkId: null,
      });

      const recordPerCheck = (
        status: 'pass' | 'fail' | 'not_run',
        notRunReason: P02NotRunReason | null,
        detail: string,
      ): void => {
        for (const checkId of step.checkIds) {
          const definition = DEFINITION_BY_ID.get(checkId);
          const requiredAssertions = definition?.requiredAssertions ?? [];
          const isNegativePass = status === 'pass' && (definition?.expectedNegative ?? false);
          const checkEvidencePath = `evidence/checks/${checkId}.json`;
          results.set(checkId, {
            checkId,
            status,
            ...(notRunReason !== null ? { notRunReason } : {}),
            ...(isNegativePass && requiredAssertions.includes('error')
              ? { errorAssertion: true }
              : {}),
            ...(isNegativePass && requiredAssertions.includes('zeroStart')
              ? { zeroStartAssertion: true }
              : {}),
            ...(isNegativePass && requiredAssertions.includes('persistentState')
              ? { persistentStateAssertion: true }
              : {}),
            durationMs: outcome.durationMs,
            detail: isNegativePass ? `${detail}；${P02_NEGATIVE_PASS_DETAIL}` : detail,
            evidenceRefs: [checkEvidencePath, logPath],
          });
          evidenceFiles.push({
            path: checkEvidencePath,
            content: `${JSON.stringify(
              {
                checkId,
                status,
                notRunReason,
                stepId: step.stepId,
                commandLog: logPath,
                exitCode: outcome.exitCode,
                signal: outcome.signal,
                timedOut: outcome.timedOut,
                durationMs: outcome.durationMs,
                stdoutTruncated: outcome.stdoutTruncated,
                stderrTruncated: outcome.stderrTruncated,
                ...(isNegativePass ? { assertions: [...requiredAssertions] } : {}),
              },
              null,
              2,
            )}\n`,
            checkId,
          });
        }
      };

      if (outcome.kind === 'spawn_error') {
        recordPerCheck(
          'not_run',
          'startup_failure',
          `步骤无法启动：${outcome.spawnError ?? '未知启动错误'}`,
        );
        halt = { reason: 'startup_failure', detail: `前序步骤 ${step.stepId} 启动失败，未启动` };
      } else if (outcome.kind === 'timeout') {
        recordPerCheck('not_run', 'timeout', `步骤超过有限超时 ${timeoutMs}ms，自有进程组已 SIGKILL`);
        halt = { reason: 'startup_failure', detail: `前序步骤 ${step.stepId} 超时，未启动` };
      } else if (outcome.kind === 'signal') {
        recordPerCheck('fail', null, `步骤被信号终止：${String(outcome.signal)}`);
        halt = { reason: 'startup_failure', detail: `前序步骤 ${step.stepId} 信号终止，未启动` };
      } else if (outcome.exitCode !== 0) {
        recordPerCheck('fail', null, `步骤退出码 ${String(outcome.exitCode)}（非零即失败）`);
        halt = { reason: 'startup_failure', detail: `前序步骤 ${step.stepId} 失败，未启动` };
      } else {
        recordPerCheck('pass', null, `步骤退出 0：${step.label}`);
        log(
          `${P02_ACCEPT_SCRIPT_NAME}: STEP [${index + 1}/${steps.length}] EXIT 0 ${step.label} (${(outcome.durationMs / 1000).toFixed(1)}s)`,
        );
      }
    }

    // 安全网：步骤计划之外的必需检查若仍未提交，明确 not_run（绝不默认通过）。
    for (const definition of P02_REQUIRED_CHECKS) {
      if (results.has(definition.id)) {
        continue;
      }
      results.set(definition.id, {
        checkId: definition.id,
        status: 'not_run',
        notRunReason: 'startup_failure',
        detail: '控制器步骤计划未提交该检查结果',
      });
      problems.push(`${definition.id}: 步骤计划未覆盖（not_run/startup_failure）`);
    }
  }

  /* ---------------- 控制检查求值（与场景步骤结果 fail-closed 合并） ---------------- */
  // P02-PHASE-NOT-RUN：控制器以聚合探针复核（存在 missing_result 即 fail）。
  results.set(
    'P02-PHASE-NOT-RUN',
    combineControlCheck(
      'P02-PHASE-NOT-RUN',
      results.get('P02-PHASE-NOT-RUN'),
      evaluateP02NotRunControl(aggregateP02CheckResults([...results.values()])),
    ),
  );

  /* ---------------- 报告装配、预校验、写出与整目录重验 ---------------- */
  const generatedAtUtc = nowUtc().toISOString();
  const assembleInput = (resultList: readonly P02CheckResultInput[]) => ({
    runId,
    generatedAtUtc,
    plan: {
      phaseId: config.plan.phaseId,
      title: config.plan.title,
      scope: config.plan.scope,
      version: config.plan.version,
      digestSha256: facts.planDigestSha256,
    },
    git: {
      commit: facts.git.commit,
      worktree: facts.git.worktree,
      branch: facts.git.branch,
      priorBaselines: config.priorBaselines.map((baseline) => ({ ...baseline })),
    },
    platform: { ...facts.platform },
    tools: { ...facts.tools },
    schemaVersions: {
      settingsSchema: facts.schemaVersions.settingsSchema,
      settingsExportFormat: facts.schemaVersions.settingsExportFormat,
      sqliteMigrations: [...facts.schemaVersions.sqliteMigrations],
      applicationWireSchema: facts.schemaVersions.applicationWireSchema,
      eventEnvelopeSchema: facts.schemaVersions.eventEnvelopeSchema,
    },
    commands,
    results: resultList,
    stateDigests: { codeSha256: facts.git.codeSha256 },
    outOfScope: P02_OUT_OF_SCOPE,
    knownLimitations: limitations,
  });

  // 与 F-009 写入器同源的脱敏+摘要，用于写出前的严格 Schema 预校验。
  const sensitive = options.sensitiveValues ?? [];
  const manifest: P02EvidenceManifestEntry[] = evidenceFiles.map((entry) => {
    const bytes =
      typeof entry.content === 'string'
        ? Buffer.from(redactSensitiveText(entry.content, sensitive), 'utf-8')
        : Buffer.from(entry.content);
    return {
      path: entry.path,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.length,
      checkId: entry.checkId ?? null,
    };
  });

  // P02-PHASE-REPORT：报告输入经严格 Schema 校验且证据清单交叉完整才与步骤结果
  // 合并为 pass；写出后再以 verifyP02ReportDirectory 整目录重验决定阶段退出码。
  let reportControl: P02ControlEvaluation;
  try {
    buildP02AcceptanceReport(assembleInput([...results.values()]), manifest);
    reportControl = {
      status: 'pass',
      detail: '报告输入通过严格 Schema 校验且证据清单交叉完整；写出后重验决定阶段退出码',
    };
  } catch (error) {
    reportControl = {
      status: 'fail',
      detail: `报告预校验失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  results.set(
    'P02-PHASE-REPORT',
    combineControlCheck('P02-PHASE-REPORT', results.get('P02-PHASE-REPORT'), reportControl),
  );

  let written: P02WrittenReport | null = null;
  let evidenceOk = false;
  try {
    written = writeP02AcceptanceReport({
      reportRoot: reportRootAbs,
      input: assembleInput([...results.values()]),
      evidenceFiles,
      sensitiveValues: sensitive,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`报告写入失败：${message}`);
    log(`${P02_ACCEPT_SCRIPT_NAME}: FAIL 报告写入失败：${message}`);
    return {
      runId,
      runDir: null,
      exitCode: 1,
      conclusion: null,
      counts: null,
      problems,
      reportWritten: false,
      evidenceOk: false,
      written: null,
    };
  }
  options.afterReportWrite?.(written.runDir);
  const verification = verifyP02ReportDirectory(written.runDir);
  evidenceOk = verification.ok;
  for (const problem of verification.problems) {
    problems.push(`报告重验：${problem}`);
  }
  problems.push(...written.problems);

  const exitCode = computeP02PhaseExitCode({
    conclusion: written.conclusion,
    evidenceOk,
    reportWritten: true,
  });
  log(
    `${P02_ACCEPT_SCRIPT_NAME}: REPORT ${written.runDir}（conclusion=${written.conclusion}，pass=${written.counts.pass} fail=${written.counts.fail} not_run=${written.counts.not_run}）`,
  );
  log(`${P02_ACCEPT_SCRIPT_NAME}: ${exitCode === 0 ? 'PASS' : 'FAIL'} exit ${exitCode}`);
  return {
    runId,
    runDir: written.runDir,
    exitCode,
    conclusion: written.conclusion,
    counts: written.counts,
    problems,
    reportWritten: true,
    evidenceOk,
    written,
  };
}

/* ------------------------------------------------------------------ *
 * CLI 入口（前提检查 → 单次阶段验收）
 * ------------------------------------------------------------------ */

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * CLI 主流程：先经 resolveP02AcceptInvocation 完成配置与 CLI/env 参数的全部校验
 * （失败 exitCode 1 且零副作用，不产生报告/不启动 Host/场景），随后执行单次
 * 阶段验收并严格传播退出码。
 */
async function main(argv: readonly string[]): Promise<number> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '..', '..');
  const resolution = resolveP02AcceptInvocation({ argv: [...argv.slice(2)], env: process.env });
  if (!resolution.ok) {
    err(`${P02_ACCEPT_SCRIPT_NAME}: FAIL ${resolution.message}`);
    return resolution.exitCode;
  }
  if (resolution.help) {
    out(P02_ACCEPT_USAGE);
    return 0;
  }
  const invocation = resolution.invocation as P02ResolvedInvocation;
  try {
    const result = await runP02Acceptance({
      repoRoot,
      config: invocation.config,
      overrides: invocation.overrides,
      log: out,
    });
    for (const problem of result.problems) {
      err(`${P02_ACCEPT_SCRIPT_NAME}: problem: ${problem}`);
    }
    return result.exitCode;
  } catch (error) {
    err(`${P02_ACCEPT_SCRIPT_NAME}: FAIL ${(error as Error).message}`);
    return 1;
  }
}

function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  // realpath 对比：沙箱/符号链接路径（如 macOS /tmp → /private/tmp）下
  // argv[1] 与 import.meta.url 的字面路径不同，不能直接字符串比较。
  try {
    return realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      err(`${P02_ACCEPT_SCRIPT_NAME}: FAIL unexpected orchestration error: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
