/**
 * P01-4 / F-008 `npm run accept:p01` 单次验收入口（验收控制器）。
 * 开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 业务接口。
 *
 * 依据 `docs/p01-4-acceptance-contract.md` §2.1/§2.4/§3.4 与 F-007 报告模块实现：
 * - 一次运行自动串联 `npm run verify`（检查 P01-ENG-VERIFY）、四个固定必需场景
 *   （持久化闭环、回滚/CAS、制品负例、配置/标签，分别承接 FR-1/FR-2 分支检查）与
 *   构建产物冒烟（P01-ENG-BUILD-SMOKE，F-009 专用 `test/p01-4-build-smoke.test.ts`：
 *   临时编译 dist 非源码 cwd 装配/制品重开 + 路径/依赖/迁移扫描）；
 * - 每一步都是**真实有界子进程**：显式 argv/cwd、不经 Shell 拼接、独立进程组、
 *   有限超时（单步与整体预算均为有限毫秒），输出有大小上限并记录截断/缺口，
 *   超时对整个进程组 SIGKILL 并核验进程停止后才继续清理；
 * - 失败语义 fail-closed：步骤非零/信号退出 → 映射检查 fail；步骤超时 →
 *   映射检查 not_run/timeout；启动失败 → not_run/startup_failure；失败即停止，
 *   未启动的必需步骤一律 not_run（绝不标为通过）；不启用 passWithNoTests、
 *   不删除测试、不把 skipped 转为 pass，也不在 npm test 中递归调用 accept:p01；
 * - 夹具准备（P01-PHASE-FIXTURE）：run-id/报告根校验、步骤入口存在性、环境事实
 *   采集（git/tools/Schema 版本交叉核对）任一失败 → 该检查 fail、其余必需检查
 *   not_run/startup_failure，仍写出报告保留已取得证据且阶段非零；
 * - 控制检查：P01-PHASE-NOT-RUN 断言全部必需检查均有提交结果（聚合无
 *   missing_result）；P01-PHASE-REPORT 断言报告输入经严格 Schema 校验且证据
 *   清单交叉完整；写出后再以 verifyP01ReportDirectory 重验，缺失/损坏证据或
 *   报告写入失败同样使阶段非零；
 * - 报告默认位置 artifacts/acceptance/p01/<run-id>/（report.json/summary.md/
 *   evidence/），由 F-007 写入器保证 run-id 目录不覆盖、证据 hash/size 可重验、
 *   合成凭据统一脱敏；命令记录在报告中使用逻辑 argv/cwd（<node>/<repo>），
 *   不写入个人绝对路径；连续两次运行互不依赖、互不覆盖证据；
 * - 执行配置 acceptance/p01.config.json 运行时严格校验：拒绝未知
 *   configVersion、非法/非正超时与任何试图移除/关闭必需检查的配置。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接运行；
 * 不调用模型，不联网，除写报告目录外不修改受检仓库中的任何文件。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, release as osRelease, type as osType } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  P01_REQUIRED_CHECKS,
  P01_REQUIRED_CHECK_IDS,
  P01ReportError,
  aggregateP01CheckResults,
  assertValidRunId,
  buildP01AcceptanceReport,
  computeP01PhaseExitCode,
  generateP01RunId,
  redactSensitiveText,
  verifyP01ReportDirectory,
  writeP01AcceptanceReport,
} from './p01-report.ts';
import type {
  P01AcceptanceReportInput,
  P01CheckResultInput,
  P01CommandRecord,
  P01EvidenceFileInput,
  P01EvidenceManifestEntry,
  P01NotRunReason,
  P01OutOfScopeEntry,
  P01WrittenReport,
} from './p01-report.ts';

/* ------------------------------------------------------------------ *
 * 常量与错误
 * ------------------------------------------------------------------ */

export const P01_ACCEPT_CONFIG_VERSION = 1;
export const P01_ACCEPT_CONFIG_PATH = 'acceptance/p01.config.json';
export const P01_ACCEPT_SCRIPT_NAME = 'accept:p01';

/** 单步/整体超时的合法范围（均为有限毫秒预算）。 */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 7_200_000;
/** 命令输出上限的合法范围（字节）。 */
const MIN_OUTPUT_BYTES = 1_024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** 环境事实采集子进程的统一有限超时。 */
const FACT_PROBE_TIMEOUT_MS = 30_000;
/** 超时 SIGKILL 后等待 close 事件的宽限期。 */
const KILL_GRACE_MS = 5_000;

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/** 不映射到执行步骤的阶段控制检查（由控制器自身求值）。 */
export const P01_CONTROL_CHECK_IDS: readonly string[] = [
  'P01-PHASE-FIXTURE',
  'P01-PHASE-NOT-RUN',
  'P01-PHASE-REPORT',
];

export const P01_ACCEPT_ENV_RUN_ID = 'SHIPLOOP_ACCEPT_P01_RUN_ID';
export const P01_ACCEPT_ENV_REPORT_DIR = 'SHIPLOOP_ACCEPT_P01_REPORT_DIR';
export const P01_ACCEPT_ENV_STEP_TIMEOUT_MS = 'SHIPLOOP_ACCEPT_P01_STEP_TIMEOUT_MS';
/** 复用既有 verify 单步超时环境变量（scripts/verify.ts）。 */
export const P01_VERIFY_ENV_STEP_TIMEOUT_MS = 'SHIPLOOP_VERIFY_STEP_TIMEOUT_MS';

export type P01AcceptErrorKind =
  | 'invalid_config'
  | 'invalid_usage'
  | 'preparation_failed'
  | 'report_write_failed';

export class P01AcceptError extends Error {
  readonly kind: P01AcceptErrorKind;
  readonly detail?: string;

  constructor(kind: P01AcceptErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'P01AcceptError';
    this.kind = kind;
    this.detail = detail;
  }
}

function fail(kind: P01AcceptErrorKind, message: string, detail?: string): never {
  throw new P01AcceptError(kind, message, detail);
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * 执行配置（acceptance/p01.config.json）运行时严格校验
 * ------------------------------------------------------------------ */

export interface P01AcceptanceTimeouts {
  /** `npm run verify` 整次调用的控制器级有限超时。 */
  readonly verifyMs: number;
  /** 每个必需场景测试文件的有限超时。 */
  readonly scenarioMs: number;
  /** 构建产物冒烟步骤的有限超时。 */
  readonly smokeMs: number;
  /** 阶段整体时间预算（含全部步骤）。 */
  readonly overallMs: number;
}

export interface P01AcceptanceConfig {
  readonly configVersion: number;
  /** 报告根目录（仓库内 POSIX 相对路径；CLI 可覆盖）。 */
  readonly reportRoot: string;
  /** 有序必需检查 ID；必须与 F-007 冻结清单完全一致（不得移除/关闭）。 */
  readonly requiredChecks: readonly string[];
  readonly timeouts: P01AcceptanceTimeouts;
  readonly maxCommandOutputBytes: number;
  readonly plan: {
    readonly phaseId: string;
    readonly stepId: string;
    readonly title: string;
    readonly scope: string;
    /** 输入计划（PRD/契约）版本。 */
    readonly version: string;
    /** 仓库内验收契约文档（输入计划摘要的来源）。 */
    readonly contractDoc: string;
  };
  readonly priorBaselines: readonly {
    phase: string;
    branch: string;
    tipCommit: string;
  }[];
  readonly schemaVersions: {
    readonly settingsSchema: number;
    readonly settingsExportFormat: number;
    readonly sqliteMigrations: readonly number[];
  };
}

function assertConfigString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_config', `${label} 必须是非空字符串`);
  }
  return value;
}

/** 配置内路径必须是 POSIX 相对路径（拒绝绝对路径与越界段）。 */
function assertConfigRelativePath(value: unknown, label: string): string {
  const path = assertConfigString(value, label);
  if (path.includes('\0') || path.startsWith('/') || path.includes('\\') || isAbsolute(path)) {
    fail('invalid_config', `${label} 必须是仓库内 POSIX 相对路径：${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid_config', `${label} 不允许空段/./..：${path}`);
  }
  return segments.join('/');
}

function assertTimeoutMs(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    fail(
      'invalid_config',
      `${label} 必须是 ${MIN_TIMEOUT_MS}~${MAX_TIMEOUT_MS} 的整数毫秒（有限超时，收到：${String(value)}）`,
    );
  }
  return value;
}

function assertAllowedConfigKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail('invalid_config', `${label} 含未知字段：${key}`);
    }
  }
}

/**
 * 严格校验执行配置：未知 configVersion、非法/非正超时、未知字段以及任何
 * 试图移除/关闭/重排必需检查的配置一律拒绝（invalid_config）。
 */
export function validateP01AcceptanceConfig(raw: unknown): P01AcceptanceConfig {
  if (!isPlainObject(raw)) {
    fail('invalid_config', '验收配置必须是对象');
  }
  assertAllowedConfigKeys(
    raw,
    [
      'configVersion',
      'reportRoot',
      'requiredChecks',
      'timeouts',
      'maxCommandOutputBytes',
      'plan',
      'priorBaselines',
      'schemaVersions',
    ],
    '验收配置',
  );

  if (raw.configVersion !== P01_ACCEPT_CONFIG_VERSION) {
    fail(
      'invalid_config',
      `未知 configVersion：${String(raw.configVersion)}（本控制器仅支持 ${P01_ACCEPT_CONFIG_VERSION}）`,
    );
  }

  const reportRoot = assertConfigRelativePath(raw.reportRoot, 'reportRoot');

  if (!Array.isArray(raw.requiredChecks)) {
    fail('invalid_config', 'requiredChecks 必须是有序检查 ID 数组');
  }
  const requiredChecks = raw.requiredChecks as unknown[];
  if (requiredChecks.length !== P01_REQUIRED_CHECK_IDS.length) {
    fail(
      'invalid_config',
      `requiredChecks 必须恰好包含 ${P01_REQUIRED_CHECK_IDS.length} 个必需检查（不得移除/关闭），收到 ${requiredChecks.length} 个`,
    );
  }
  requiredChecks.forEach((value, index) => {
    const expected = P01_REQUIRED_CHECK_IDS[index] as string;
    if (value !== expected) {
      fail(
        'invalid_config',
        `requiredChecks[${index}] 必须是 ${expected}（顺序固定，不得移除/关闭/重排必需检查），收到：${String(value)}`,
      );
    }
  });

  if (!isPlainObject(raw.timeouts)) {
    fail('invalid_config', 'timeouts 必须是对象');
  }
  assertAllowedConfigKeys(raw.timeouts, ['verifyMs', 'scenarioMs', 'smokeMs', 'overallMs'], 'timeouts');
  const timeouts: P01AcceptanceTimeouts = {
    verifyMs: assertTimeoutMs(raw.timeouts.verifyMs, 'timeouts.verifyMs'),
    scenarioMs: assertTimeoutMs(raw.timeouts.scenarioMs, 'timeouts.scenarioMs'),
    smokeMs: assertTimeoutMs(raw.timeouts.smokeMs, 'timeouts.smokeMs'),
    overallMs: assertTimeoutMs(raw.timeouts.overallMs, 'timeouts.overallMs'),
  };

  const maxCommandOutputBytes = raw.maxCommandOutputBytes;
  if (
    typeof maxCommandOutputBytes !== 'number' ||
    !Number.isInteger(maxCommandOutputBytes) ||
    maxCommandOutputBytes < MIN_OUTPUT_BYTES ||
    maxCommandOutputBytes > MAX_OUTPUT_BYTES
  ) {
    fail(
      'invalid_config',
      `maxCommandOutputBytes 必须是 ${MIN_OUTPUT_BYTES}~${MAX_OUTPUT_BYTES} 的整数（输出有大小上限）`,
    );
  }

  if (!isPlainObject(raw.plan)) {
    fail('invalid_config', 'plan 必须是对象');
  }
  assertAllowedConfigKeys(
    raw.plan,
    ['phaseId', 'stepId', 'title', 'scope', 'version', 'contractDoc'],
    'plan',
  );
  const plan = {
    phaseId: assertConfigString(raw.plan.phaseId, 'plan.phaseId'),
    stepId: assertConfigString(raw.plan.stepId, 'plan.stepId'),
    title: assertConfigString(raw.plan.title, 'plan.title'),
    scope: assertConfigString(raw.plan.scope, 'plan.scope'),
    version: assertConfigString(raw.plan.version, 'plan.version'),
    contractDoc: assertConfigRelativePath(raw.plan.contractDoc, 'plan.contractDoc'),
  };

  if (!Array.isArray(raw.priorBaselines) || raw.priorBaselines.length === 0) {
    fail('invalid_config', 'priorBaselines 必须是非空数组');
  }
  const priorBaselines = (raw.priorBaselines as unknown[]).map((entry, index) => {
    const label = `priorBaselines[${index}]`;
    if (!isPlainObject(entry)) {
      fail('invalid_config', `${label} 必须是对象`);
    }
    assertAllowedConfigKeys(entry, ['phase', 'branch', 'tipCommit'], label);
    const tipCommit = assertConfigString(entry.tipCommit, `${label}.tipCommit`);
    if (!HEX_40.test(tipCommit)) {
      fail('invalid_config', `${label}.tipCommit 必须是 40 位小写十六进制 commit`);
    }
    return {
      phase: assertConfigString(entry.phase, `${label}.phase`),
      branch: assertConfigString(entry.branch, `${label}.branch`),
      tipCommit,
    };
  });

  if (!isPlainObject(raw.schemaVersions)) {
    fail('invalid_config', 'schemaVersions 必须是对象');
  }
  assertAllowedConfigKeys(
    raw.schemaVersions,
    ['settingsSchema', 'settingsExportFormat', 'sqliteMigrations'],
    'schemaVersions',
  );
  const assertPositiveInt = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      fail('invalid_config', `${label} 必须是正整数`);
    }
    return value;
  };
  const sqliteMigrations = raw.schemaVersions.sqliteMigrations;
  if (!Array.isArray(sqliteMigrations) || sqliteMigrations.length === 0) {
    fail('invalid_config', 'schemaVersions.sqliteMigrations 必须是非空数组');
  }
  sqliteMigrations.forEach((version, index) => {
    assertPositiveInt(version, `schemaVersions.sqliteMigrations[${index}]`);
    if (index > 0 && (version as number) <= (sqliteMigrations[index - 1] as number)) {
      fail('invalid_config', 'schemaVersions.sqliteMigrations 必须严格递增');
    }
  });

  return {
    configVersion: P01_ACCEPT_CONFIG_VERSION,
    reportRoot,
    requiredChecks: [...P01_REQUIRED_CHECK_IDS],
    timeouts,
    maxCommandOutputBytes,
    plan,
    priorBaselines,
    schemaVersions: {
      settingsSchema: assertPositiveInt(raw.schemaVersions.settingsSchema, 'schemaVersions.settingsSchema'),
      settingsExportFormat: assertPositiveInt(
        raw.schemaVersions.settingsExportFormat,
        'schemaVersions.settingsExportFormat',
      ),
      sqliteMigrations: [...(sqliteMigrations as readonly number[])],
    },
  };
}

/** 从 JSON 文件加载并严格校验执行配置；文件缺失/不可解析同样 invalid_config。 */
export function loadP01AcceptanceConfig(configPath: string): P01AcceptanceConfig {
  if (!existsSync(configPath)) {
    fail('invalid_config', `验收配置不存在：${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    fail('invalid_config', `验收配置无法解析：${(error as Error).message}`);
  }
  return validateP01AcceptanceConfig(parsed);
}

/* ------------------------------------------------------------------ *
 * 有界子进程（显式 argv/cwd、输出上限、超时进程组 SIGKILL 并核验停止）
 * ------------------------------------------------------------------ */

export interface P01BoundedRunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface P01BoundedRunOutcome {
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
 * 超时对整个进程组 SIGKILL，等待 close 事件核验进程停止（宽限期后兜底）。
 */
export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: P01BoundedRunOptions,
): Promise<P01BoundedRunOutcome> {
  return new Promise((resolveOutcome) => {
    const started = Date.now();
    const stdout = createCappedCollector(options.maxOutputBytes);
    const stderr = createCappedCollector(options.maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const settle = (outcome: P01BoundedRunOutcome): void => {
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
      resolveOutcome(outcome);
    };

    const buildOutcome = (
      kind: P01BoundedRunOutcome['kind'],
      exitCode: number | null,
      signal: string | null,
      stoppedVerified: boolean,
    ): P01BoundedRunOutcome => ({
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
      if (child.pid !== undefined) {
        try {
          // 负 pid 杀掉整个进程组（含孙进程），随后等待 close 核验停止。
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
 * 执行步骤计划（verify + 固定必需场景 + 构建冒烟）
 * ------------------------------------------------------------------ */

export interface P01AcceptanceStep {
  readonly stepId: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** 本步骤承接的必需检查 ID（顺序固定）。 */
  readonly checkIds: readonly string[];
  readonly timeoutMs: number;
  /** 附加环境变量（叠加在控制器环境之上）。 */
  readonly env?: Readonly<Record<string, string>>;
}

/** 必需场景：测试文件 → 承接的必需检查 ID（契约 §2.1）。 */
export const P01_SCENARIO_STEPS = [
  {
    stepId: 'scenario-closed-loop',
    label: '持久化闭环场景（P01-FR1-NORMAL / P01-FR1-REOPEN）',
    testFile: 'test/p01-4-persistence-closed-loop.test.ts',
    checkIds: ['P01-FR1-NORMAL', 'P01-FR1-REOPEN'],
  },
  {
    stepId: 'scenario-rollback-cas',
    label: 'SQLite 回滚与配置 CAS 场景（P01-FR1-ROLLBACK / P01-FR2-ROLLBACK / P01-FR2-CAS）',
    testFile: 'test/p01-4-sqlite-rollback-and-cas.test.ts',
    checkIds: ['P01-FR1-ROLLBACK', 'P01-FR2-ROLLBACK', 'P01-FR2-CAS'],
  },
  {
    stepId: 'scenario-artifact-negative',
    label: '制品缺失/恢复负例场景（P01-FR2-ARTIFACT-MISSING / P01-FR2-ARTIFACT-RECOVERY）',
    testFile: 'test/p01-4-artifact-negative.test.ts',
    checkIds: ['P01-FR2-ARTIFACT-MISSING', 'P01-FR2-ARTIFACT-RECOVERY'],
  },
  {
    stepId: 'scenario-config-tags',
    label: '当前配置与项目标签场景（P01-FR2-CONFIG / P01-FR2-TAGS）',
    testFile: 'test/p01-4-config-and-tags.test.ts',
    checkIds: ['P01-FR2-CONFIG', 'P01-FR2-TAGS'],
  },
] as const;

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

export interface P01ProductionStepOptions {
  readonly stepTimeoutMs?: number;
  readonly verifyTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * 生产步骤计划：`npm run verify` → 四个固定必需场景（各自真实有界子进程，
 * 经 scripts/run-tests.ts 以本地锁定 vitest 运行）→ 构建产物冒烟
 * （scripts/smoke-built-entries.ts：dist 入口校验 + 非源码 cwd 装配冒烟）。
 * 步骤映射必须恰好覆盖全部非控制类必需检查各一次，否则视为接线错误拒绝。
 */
export function buildP01ProductionSteps(
  config: P01AcceptanceConfig,
  options: P01ProductionStepOptions = {},
): P01AcceptanceStep[] {
  const env = options.env ?? process.env;
  const npm = resolveNpm(env);
  const scenarioTimeoutMs = options.stepTimeoutMs ?? config.timeouts.scenarioMs;
  const smokeTimeoutMs = options.stepTimeoutMs ?? config.timeouts.smokeMs;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? config.timeouts.verifyMs;

  const steps: P01AcceptanceStep[] = [
    {
      stepId: 'verify',
      label: 'npm run verify（test/typecheck/build）',
      command: npm.command,
      args: [...npm.argsPrefix, 'run', 'verify'],
      checkIds: ['P01-ENG-VERIFY'],
      timeoutMs: verifyTimeoutMs,
      ...(options.verifyTimeoutMs !== undefined
        ? { env: { [P01_VERIFY_ENV_STEP_TIMEOUT_MS]: String(options.verifyTimeoutMs) } }
        : {}),
    },
  ];
  for (const scenario of P01_SCENARIO_STEPS) {
    steps.push({
      stepId: scenario.stepId,
      label: scenario.label,
      command: process.execPath,
      args: ['scripts/run-tests.ts', scenario.testFile],
      checkIds: [...scenario.checkIds],
      timeoutMs: scenarioTimeoutMs,
    });
  }
  steps.push({
    stepId: 'build-smoke',
    label: '构建产物冒烟与路径扫描（非源码 cwd 装配 + 制品关闭重开）',
    command: process.execPath,
    args: ['scripts/run-tests.ts', 'test/p01-4-build-smoke.test.ts'],
    checkIds: ['P01-ENG-BUILD-SMOKE'],
    timeoutMs: smokeTimeoutMs,
  });

  // 接线自检：映射必须恰好覆盖全部非控制类必需检查各一次（fail-closed）。
  const expected = P01_REQUIRED_CHECK_IDS.filter((id) => !P01_CONTROL_CHECK_IDS.includes(id));
  const mapped = steps.flatMap((step) => step.checkIds);
  const seen = new Set<string>();
  for (const checkId of mapped) {
    if (seen.has(checkId)) {
      fail('invalid_config', `步骤计划重复映射检查：${checkId}`);
    }
    seen.add(checkId);
    if (!expected.includes(checkId)) {
      fail('invalid_config', `步骤计划映射了非必需/控制检查：${checkId}`);
    }
  }
  for (const checkId of expected) {
    if (!seen.has(checkId)) {
      fail('invalid_config', `步骤计划缺少必需检查的承接步骤：${checkId}`);
    }
  }
  return steps;
}

/**
 * 步骤入口存在性核验（准备期，fail-closed）：node 脚本步骤的脚本文件入口
 * （.ts/.mts/.cts/.mjs/.cjs/.js 参数）必须实际存在；相对入口相对仓库根解析，
 * 绝对入口（如 npm_execpath）直接核验。npm 子命令与内联脚本不是文件入口；
 * 缺失必需工具/入口即准备失败，绝不 skip。
 */
export function assertP01StepEntriesExist(
  steps: readonly P01AcceptanceStep[],
  repoRoot: string,
): void {
  const SCRIPT_ENTRY_PATTERN = /\.(ts|mts|cts|mjs|cjs|js)$/;
  for (const step of steps) {
    if (step.command !== process.execPath) {
      continue;
    }
    for (const arg of step.args) {
      if (arg.startsWith('-')) {
        break; // 内联脚本（-e）：无文件入口可查。
      }
      if (!SCRIPT_ENTRY_PATTERN.test(arg)) {
        continue; // npm 子命令等非文件参数。
      }
      const absolute = isAbsolute(arg) ? arg : resolve(repoRoot, arg);
      if (!existsSync(absolute)) {
        fail('preparation_failed', `步骤 ${step.stepId} 的入口不存在：${arg}`, step.stepId);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 环境事实采集（git/tools/Schema 版本交叉核对/输入计划摘要）
 * ------------------------------------------------------------------ */

export interface P01EnvironmentFacts {
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
  readonly schemaVersions: P01AcceptanceConfig['schemaVersions'];
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

/** 从源码文本交叉核对配置声明的 Schema 版本（防文档/配置与实现漂移）。 */
function crossCheckSchemaVersions(repoRoot: string, config: P01AcceptanceConfig): void {
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
  const serviceSource = readSource('packages/core/src/application/configuration-service.ts');
  const exportMatch = /export const SETTINGS_EXPORT_FORMAT_VERSION = (\d+);/.exec(serviceSource);
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
  const expected = config.schemaVersions.sqliteMigrations;
  if (
    declared.length !== expected.length ||
    declared.some((version, index) => version !== expected[index])
  ) {
    fail(
      'preparation_failed',
      `SQLITE_MIGRATIONS 版本与配置不一致（源码=[${declared.join(',')}] 配置=[${expected.join(',')}]）`,
      'sqlite-migrations',
    );
  }
}

/**
 * 采集报告所需的真实环境事实：受测 commit/工作树/分支、代码摘要、平台、
 * 实际 Node/npm/Git/SQLite/驱动/ORM 版本、Schema 版本交叉核对与输入计划摘要。
 * 任一探测失败即 preparation_failed（必要工具/驱动缺失显式失败而非 skip）。
 */
export async function collectP01EnvironmentFacts(
  repoRoot: string,
  config: P01AcceptanceConfig,
): Promise<P01EnvironmentFacts> {
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

  crossCheckSchemaVersions(repoRoot, config);

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
      betterSqlite3: readDependencyVersion('better-sqlite3', 'tools.better-sqlite3'),
      drizzleOrm: readDependencyVersion('drizzle-orm', 'tools.drizzle-orm'),
    },
    schemaVersions: {
      settingsSchema: config.schemaVersions.settingsSchema,
      settingsExportFormat: config.schemaVersions.settingsExportFormat,
      sqliteMigrations: [...config.schemaVersions.sqliteMigrations],
    },
    planDigestSha256,
  };
}

/** 夹具准备失败时的显式占位事实（报告仍需通过严格 Schema；限制中明确标注）。 */
function fallbackFacts(config: P01AcceptanceConfig): P01EnvironmentFacts {
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
    },
    planDigestSha256: '0'.repeat(64),
  };
}

/* ------------------------------------------------------------------ *
 * 验收控制器
 * ------------------------------------------------------------------ */

export interface P01AcceptanceRunOverrides {
  readonly runId?: string;
  readonly reportDir?: string;
  readonly stepTimeoutMs?: number;
  readonly verifyTimeoutMs?: number;
}

export interface P01AcceptancePrepareContext {
  readonly runId: string;
  readonly reportRoot: string;
  readonly repoRoot: string;
  readonly facts: P01EnvironmentFacts;
  readonly steps: readonly P01AcceptanceStep[];
}

export interface P01AcceptanceRunOptions {
  readonly repoRoot: string;
  readonly config: P01AcceptanceConfig;
  readonly overrides?: P01AcceptanceRunOverrides;
  /** 步骤计划注入（默认生产计划）；测试以真实有界子进程替换为快速步骤。 */
  readonly steps?: readonly P01AcceptanceStep[];
  readonly env?: NodeJS.ProcessEnv;
  /** 需要脱敏的敏感值（合成凭据等），透传 F-007 写入器统一脱敏。 */
  readonly sensitiveValues?: readonly string[];
  readonly nowUtc?: () => Date;
  readonly runIdSuffix?: string;
  /** 准备期注入钩子（测试注入准备错误）。 */
  readonly prepare?: (context: P01AcceptancePrepareContext) => void;
  /** 环境事实采集注入（默认真实采集）。 */
  readonly collectFacts?: (
    repoRoot: string,
    config: P01AcceptanceConfig,
  ) => Promise<P01EnvironmentFacts>;
  readonly log?: (message: string) => void;
}

export interface P01AcceptanceRunResult {
  readonly runId: string;
  readonly runDir: string | null;
  readonly exitCode: number;
  readonly conclusion: 'pass' | 'fail' | null;
  readonly counts: { pass: number; fail: number; not_run: number; total: number } | null;
  readonly problems: readonly string[];
  readonly reportWritten: boolean;
  readonly evidenceOk: boolean;
  readonly written: P01WrittenReport | null;
}

/** 阶段外能力：标记 not_run/unsupported，不计入必需项通过数（契约 §2.4/§6）。 */
const P01_OUT_OF_SCOPE: readonly P01OutOfScopeEntry[] = [
  {
    id: 'P01-OOS-MODEL-LIVE',
    capability: 'Runtime/Pi SDK 模型 Live 调用',
    status: 'not_run',
    note: 'P01 无模型调用；本阶段不运行也不计入必需项通过数',
  },
  {
    id: 'P01-OOS-STRONG-SANDBOX',
    capability: '强 OS 沙箱',
    status: 'unsupported',
    note: '首版为可信项目模式，强沙箱按路线后续建设',
  },
  {
    id: 'P01-OOS-NON-MACOS',
    capability: 'Windows/WSL/Linux 平台验收',
    status: 'not_run',
    note: '正式验收限 macOS；其他平台另行验收',
  },
  {
    id: 'P01-OOS-HOST-CLI',
    capability: 'Host 网络接口与 CLI 业务命令',
    status: 'not_run',
    note: '本阶段无 Host 网络接口/CLI 业务能力，不编造未实现命令',
  },
];

const P01_KNOWN_LIMITATIONS: readonly string[] = [
  '正式验收平台限 macOS；Windows/WSL/Linux 未验收。',
  '可信项目模式不等于强 OS 沙箱；Pi 默认工具无强 OS 沙箱。',
  'T03/T24/T26/T32 仅覆盖 P01 已实现子集（验收契约 §4）；完整 Task 策略复制属 P03，本阶段不建执行表。',
  'P01-ENG-BUILD-SMOKE 由 test/p01-4-build-smoke.test.ts 承接：临时编译 dist 在非源码 cwd 装配并发布/重开制品，同时扫描个人绝对路径/被禁运行依赖/缺失迁移资源；verify 的 build 在它之前完成。',
];

/** 逻辑 argv/cwd 映射：报告与证据不写入个人绝对路径。 */
function logicalArg(value: string, repoRoot: string): string {
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
  step: P01AcceptanceStep,
  outcome: P01BoundedRunOutcome,
  repoRoot: string,
  maxOutputBytes: number,
): string {
  const lines: string[] = [];
  lines.push(`# accept:p01 step log`);
  lines.push(`step: ${step.stepId}`);
  lines.push(`label: ${step.label}`);
  lines.push(`argv: ${[step.command, ...step.args].map((arg) => logicalArg(arg, repoRoot)).join(' ')}`);
  lines.push(`cwd: <repo>`);
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
  lines.push(outcome.stdout);
  if (outcome.stdoutTruncated) {
    lines.push(`[output truncated: kept first ${maxOutputBytes} of ${outcome.stdoutBytes} bytes]`);
  }
  lines.push('--- stderr ---');
  lines.push(outcome.stderr);
  if (outcome.stderrTruncated) {
    lines.push(`[output truncated: kept first ${maxOutputBytes} of ${outcome.stderrBytes} bytes]`);
  }
  return `${lines.join('\n')}\n`;
}

const NEGATIVE_PASS_DETAIL =
  '预期负例：错误断言与副作用断言由测试入口内的真实断言承载，步骤退出 0 表示两者同时成立';

/**
 * 执行一次 P01 阶段验收：准备（夹具）→ 逐步执行（fail-fast，未启动标
 * not_run）→ 控制检查求值 → 报告写出与重验 → 退出码。
 * 报告在任何临时资源清理前写出；报告写入失败同样非零且诊断明确。
 */
export async function runP01Acceptance(
  options: P01AcceptanceRunOptions,
): Promise<P01AcceptanceRunResult> {
  const { repoRoot, config } = options;
  const baseEnv = options.env ?? process.env;
  const nowUtc = options.nowUtc ?? (() => new Date());
  const log = options.log ?? ((): void => undefined);
  const problems: string[] = [];
  const commands: P01CommandRecord[] = [];
  const evidenceFiles: P01EvidenceFileInput[] = [];
  const results = new Map<string, P01CheckResultInput>();
  const limitations = [...P01_KNOWN_LIMITATIONS];

  // run-id：覆盖值非法属于用法错误（拒绝，不产生报告）。
  let runId: string;
  try {
    runId =
      options.overrides?.runId ?? generateP01RunId(nowUtc(), options.runIdSuffix);
    assertValidRunId(runId);
  } catch (error) {
    fail(
      'invalid_usage',
      `run-id 非法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const reportRootAbs =
    options.overrides?.reportDir !== undefined
      ? resolve(options.overrides.reportDir)
      : resolve(repoRoot, config.reportRoot);
  const overallDeadline = Date.now() + config.timeouts.overallMs;

  /* ---------------- 准备（P01-PHASE-FIXTURE） ---------------- */
  let facts: P01EnvironmentFacts;
  let steps: readonly P01AcceptanceStep[] = [];
  let fixtureFailure: string | null = null;
  try {
    if (existsSync(reportRootAbs) && !statSync(reportRootAbs).isDirectory()) {
      fail('preparation_failed', `报告根不是目录：${reportRootAbs}`);
    }
    steps =
      options.steps ??
      buildP01ProductionSteps(config, {
        ...(options.overrides?.stepTimeoutMs !== undefined
          ? { stepTimeoutMs: options.overrides.stepTimeoutMs }
          : {}),
        ...(options.overrides?.verifyTimeoutMs !== undefined
          ? { verifyTimeoutMs: options.overrides.verifyTimeoutMs }
          : {}),
        env: baseEnv,
      });
    assertP01StepEntriesExist(steps, repoRoot);
    facts = await (options.collectFacts ?? collectP01EnvironmentFacts)(repoRoot, config);
    options.prepare?.({ runId, reportRoot: reportRootAbs, repoRoot, facts, steps });
  } catch (error) {
    fixtureFailure =
      error instanceof P01AcceptError || error instanceof P01ReportError
        ? error.message
        : `夹具准备异常：${(error as Error).message}`;
    facts = fallbackFacts(config);
    limitations.push('夹具准备/环境事实采集失败：git/tools/摘要字段为显式占位，详见 P01-PHASE-FIXTURE。');
  }

  const overridesSnapshot = {
    ...(options.overrides ?? {}),
    ...(options.overrides?.reportDir !== undefined ? { reportDir: '<report-root>' } : {}),
  };
  evidenceFiles.push({
    path: 'evidence/config.json',
    content: `${JSON.stringify({ config, overrides: overridesSnapshot }, null, 2)}\n`,
    checkId: 'P01-PHASE-FIXTURE',
  });
  evidenceFiles.push({
    path: 'evidence/environment.json',
    content: `${JSON.stringify(facts, null, 2)}\n`,
    checkId: 'P01-PHASE-FIXTURE',
  });

  /* ---------------- 步骤执行（fail-fast） ---------------- */
  if (fixtureFailure !== null) {
    results.set('P01-PHASE-FIXTURE', {
      checkId: 'P01-PHASE-FIXTURE',
      status: 'fail',
      detail: fixtureFailure,
      evidenceRefs: ['evidence/config.json', 'evidence/environment.json'],
    });
    for (const definition of P01_REQUIRED_CHECKS) {
      if (definition.id === 'P01-PHASE-FIXTURE') {
        continue;
      }
      results.set(definition.id, {
        checkId: definition.id,
        status: 'not_run',
        notRunReason: 'startup_failure',
        detail: '夹具准备失败，依赖检查未启动',
      });
    }
    log(`accept:p01: FIXTURE FAIL ${fixtureFailure}`);
  } else {
    results.set('P01-PHASE-FIXTURE', {
      checkId: 'P01-PHASE-FIXTURE',
      status: 'pass',
      detail: '夹具准备、步骤入口与环境事实采集完成',
      evidenceRefs: ['evidence/config.json', 'evidence/environment.json'],
    });

    let halt: { readonly reason: P01NotRunReason; readonly detail: string } | null = null;
    for (const [index, step] of steps.entries()) {
      const markChecks = (
        status: 'pass' | 'fail' | 'not_run',
        notRunReason: P01NotRunReason | null,
        detail: string,
        extra: Partial<P01CheckResultInput> = {},
      ): void => {
        for (const checkId of step.checkIds) {
          results.set(checkId, {
            checkId,
            status,
            ...(notRunReason !== null ? { notRunReason } : {}),
            detail,
            ...extra,
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
      log(`accept:p01: STEP [${index + 1}/${steps.length}] RUN ${step.label}`);
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

      const negative = (checkId: string): boolean =>
        P01_REQUIRED_CHECKS.find((definition) => definition.id === checkId)?.expectedNegative ===
        true;
      const recordPerCheck = (
        status: 'pass' | 'fail' | 'not_run',
        notRunReason: P01NotRunReason | null,
        detail: string,
      ): void => {
        for (const checkId of step.checkIds) {
          const checkEvidencePath = `evidence/checks/${checkId}.json`;
          const isNegativePass = status === 'pass' && negative(checkId);
          results.set(checkId, {
            checkId,
            status,
            ...(notRunReason !== null ? { notRunReason } : {}),
            ...(isNegativePass ? { errorAssertion: true, sideEffectAssertion: true } : {}),
            durationMs: outcome.durationMs,
            detail: isNegativePass ? `${detail}；${NEGATIVE_PASS_DETAIL}` : detail,
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
                ...(isNegativePass ? { assertions: NEGATIVE_PASS_DETAIL } : {}),
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
        recordPerCheck('not_run', 'timeout', `步骤超过有限超时 ${timeoutMs}ms，进程组已 SIGKILL`);
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
          `accept:p01: STEP [${index + 1}/${steps.length}] EXIT 0 ${step.label} (${(outcome.durationMs / 1000).toFixed(1)}s)`,
        );
      }
    }

    // 安全网：步骤计划之外的必需非控制检查若仍未提交，明确 not_run（绝不默认通过）。
    for (const definition of P01_REQUIRED_CHECKS) {
      if (P01_CONTROL_CHECK_IDS.includes(definition.id) || results.has(definition.id)) {
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

    /* ---------------- 控制检查求值 ---------------- */
    // P01-PHASE-NOT-RUN：全部必需检查均有提交结果（聚合不得出现 missing_result）。
    results.set('P01-PHASE-NOT-RUN', {
      checkId: 'P01-PHASE-NOT-RUN',
      status: 'pass',
      detail: '占位（待聚合核对）',
    });
    results.set('P01-PHASE-REPORT', {
      checkId: 'P01-PHASE-REPORT',
      status: 'pass',
      detail: '占位（待严格 Schema 预校验）',
    });
    const probeAggregation = aggregateP01CheckResults([...results.values()]);
    const missingResults = probeAggregation.checks
      .filter((check) => check.status === 'not_run' && check.notRunReason === 'missing_result')
      .map((check) => check.id);
    if (missingResults.length > 0) {
      results.set('P01-PHASE-NOT-RUN', {
        checkId: 'P01-PHASE-NOT-RUN',
        status: 'fail',
        detail: `存在未提交结果的必需检查：${missingResults.join(', ')}`,
      });
    } else {
      results.set('P01-PHASE-NOT-RUN', {
        checkId: 'P01-PHASE-NOT-RUN',
        status: 'pass',
        detail: '全部必需检查均有提交结果；未提交/启动失败/超时/被跳过项均显式分类为 not_run',
      });
    }
  }

  /* ---------------- 报告装配、写出与重验 ---------------- */
  const generatedAtUtc = nowUtc().toISOString();
  const assembleInput = (resultList: readonly P01CheckResultInput[]): P01AcceptanceReportInput => ({
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
    },
    commands,
    results: resultList,
    stateDigests: { codeSha256: facts.git.codeSha256 },
    outOfScope: P01_OUT_OF_SCOPE,
    knownLimitations: limitations,
  });

  // 与 F-007 写入器同源的脱敏+摘要，用于写出前的严格 Schema 预校验。
  const sensitive = options.sensitiveValues ?? [];
  const manifest: P01EvidenceManifestEntry[] = evidenceFiles.map((entry) => {
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

  // P01-PHASE-REPORT：报告输入经严格 Schema 校验且证据清单交叉完整才为 pass。
  if (fixtureFailure === null) {
    try {
      buildP01AcceptanceReport(assembleInput([...results.values()]), manifest);
      results.set('P01-PHASE-REPORT', {
        checkId: 'P01-PHASE-REPORT',
        status: 'pass',
        detail:
          '报告输入通过严格 Schema 校验且证据清单交叉完整；写出后重验决定阶段退出码',
      });
    } catch (error) {
      results.set('P01-PHASE-REPORT', {
        checkId: 'P01-PHASE-REPORT',
        status: 'fail',
        detail: `报告预校验失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  let written: P01WrittenReport | null = null;
  let evidenceOk = false;
  try {
    written = writeP01AcceptanceReport({
      reportRoot: reportRootAbs,
      input: assembleInput([...results.values()]),
      evidenceFiles,
      sensitiveValues: sensitive,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`报告写入失败：${message}`);
    log(`accept:p01: FAIL 报告写入失败：${message}`);
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
  const verification = verifyP01ReportDirectory(written.runDir);
  evidenceOk = verification.ok;
  for (const problem of verification.problems) {
    problems.push(`报告重验：${problem}`);
  }
  problems.push(...written.problems);

  const exitCode = computeP01PhaseExitCode({
    conclusion: written.conclusion,
    evidenceOk,
    reportWritten: true,
  });
  log(
    `accept:p01: REPORT ${written.runDir}（conclusion=${written.conclusion}，pass=${written.counts.pass} fail=${written.counts.fail} not_run=${written.counts.not_run}）`,
  );
  log(`accept:p01: ${exitCode === 0 ? 'PASS' : 'FAIL'} exit ${exitCode}`);
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
 * CLI
 * ------------------------------------------------------------------ */

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : null;
}

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

function printUsage(): void {
  out(
    'usage: npm run accept:p01 -- [--run-id <id>] [--report-dir <dir>] ' +
      '[--step-timeout-ms <ms>] [--verify-timeout-ms <ms>] [--config <path>]\n' +
      `  --run-id <id>           指定 run-id（亦可经 ${P01_ACCEPT_ENV_RUN_ID}；缺省自动生成）\n` +
      `  --report-dir <dir>      报告根目录（亦可经 ${P01_ACCEPT_ENV_REPORT_DIR}；缺省取配置 reportRoot）\n` +
      `  --step-timeout-ms <ms>  场景/冒烟步骤超时覆盖（亦可经 ${P01_ACCEPT_ENV_STEP_TIMEOUT_MS}）\n` +
      `  --verify-timeout-ms <ms> verify 步骤超时覆盖（并传递给 ${P01_VERIFY_ENV_STEP_TIMEOUT_MS}）\n` +
      `  --config <path>         执行配置路径（默认 ${P01_ACCEPT_CONFIG_PATH}）`,
  );
}

async function main(argv: string[]): Promise<number> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '..', '..');
  let configPath = resolve(repoRoot, P01_ACCEPT_CONFIG_PATH);
  const overrides: {
    runId?: string;
    reportDir?: string;
    stepTimeoutMs?: number;
    verifyTimeoutMs?: number;
  } = {};

  const envRunId = process.env[P01_ACCEPT_ENV_RUN_ID];
  if (typeof envRunId === 'string' && envRunId.length > 0) {
    overrides.runId = envRunId;
  }
  const envReportDir = process.env[P01_ACCEPT_ENV_REPORT_DIR];
  if (typeof envReportDir === 'string' && envReportDir.length > 0) {
    overrides.reportDir = envReportDir;
  }
  const envStepTimeout = process.env[P01_ACCEPT_ENV_STEP_TIMEOUT_MS];
  if (typeof envStepTimeout === 'string' && envStepTimeout.length > 0) {
    const parsed = parsePositiveInt(envStepTimeout);
    if (parsed === null) {
      err(`accept:p01: FAIL ${P01_ACCEPT_ENV_STEP_TIMEOUT_MS}="${envStepTimeout}" 不是正整数毫秒值`);
      return 1;
    }
    overrides.stepTimeoutMs = parsed;
  }

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === '--run-id' && i + 1 < rest.length) {
      overrides.runId = rest[i + 1] as string;
      i += 1;
    } else if (arg === '--report-dir' && i + 1 < rest.length) {
      overrides.reportDir = rest[i + 1] as string;
      i += 1;
    } else if (arg === '--step-timeout-ms' && i + 1 < rest.length) {
      const parsed = parsePositiveInt(rest[i + 1] as string);
      if (parsed === null) {
        err(`accept:p01: FAIL --step-timeout-ms "${rest[i + 1] as string}" 不是正整数毫秒值`);
        return 1;
      }
      overrides.stepTimeoutMs = parsed;
      i += 1;
    } else if (arg === '--verify-timeout-ms' && i + 1 < rest.length) {
      const parsed = parsePositiveInt(rest[i + 1] as string);
      if (parsed === null) {
        err(`accept:p01: FAIL --verify-timeout-ms "${rest[i + 1] as string}" 不是正整数毫秒值`);
        return 1;
      }
      overrides.verifyTimeoutMs = parsed;
      i += 1;
    } else if (arg === '--config' && i + 1 < rest.length) {
      configPath = resolve(rest[i + 1] as string);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      return 0;
    } else {
      err(`accept:p01: unknown argument "${arg}"`);
      printUsage();
      return 1;
    }
  }

  let config: P01AcceptanceConfig;
  try {
    config = loadP01AcceptanceConfig(configPath);
  } catch (error) {
    err(`accept:p01: FAIL ${(error as Error).message}`);
    return 1;
  }

  try {
    const result = await runP01Acceptance({
      repoRoot,
      config,
      overrides,
      log: out,
    });
    for (const problem of result.problems) {
      err(`accept:p01: problem: ${problem}`);
    }
    return result.exitCode;
  } catch (error) {
    err(`accept:p01: FAIL ${(error as Error).message}`);
    return 1;
  }
}

const invokedPath = process.argv[1] !== undefined ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      err(`accept:p01: FAIL unexpected orchestration error: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
