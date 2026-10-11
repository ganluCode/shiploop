/**
 * P02-4 / F-010 版本化 P02 阶段验收配置、稳定场景清单与参数校验
 * （开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口）。
 *
 * 按 `docs/p02-4-acceptance-contract.md`（F-001）§2.1 / §3.7 / §3.8 冻结约定实现：
 * - 仓库内版本化配置 `acceptance/p02.config.json`（`configVersion=1`）固定：
 *   必需检查 → 实际场景入口的映射（`scenarios`，顺序与内容与 F-009 冻结的
 *   `P02_REQUIRED_CHECKS` 逐项一致）、报告根（默认 `artifacts/acceptance/p02`，
 *   每次运行 `<reportRoot>/<run-id>/`）与有限步骤/整体预算（`timeouts`）；
 * - 运行时严格校验（fail-closed）：拒绝未知 configVersion、未知/缺失/重复检查 ID、
 *   移除或关闭必需项（含 `enabled`/`required`/`defaultStatus` 类开关字段与改写
 *   场景入口）、非法 run-id、非正/无限超时、报告路径逃逸与任何认证/凭据字段
 *   （配置不解析用户认证）；阶段外能力（`P02-OOS-*`）不得列入必需检查或默认通过；
 * - CLI/env 只提供**已记录的**报告位置与有限预算覆盖：
 *   `--run-id` / `--report-dir` / `--step-timeout-ms` / `--verify-timeout-ms`（`--help`），
 *   环境变量 `SHIPLOOP_ACCEPT_P02_RUN_ID` / `SHIPLOOP_ACCEPT_P02_REPORT_DIR` /
 *   `SHIPLOOP_ACCEPT_P02_STEP_TIMEOUT_MS` / 复用 `SHIPLOOP_VERIFY_STEP_TIMEOUT_MS`；
 *   不提供跳过认证/负例/verify 的开关——`--skip*`/`--no-*`/`--only`/`--exclude` 与
 *   未记录的 `SHIPLOOP_ACCEPT_P02_*` 环境变量一律拒绝；
 * - `resolveP02AcceptInvocation` 在**启动 Host 或场景之前**完成全部配置/参数校验，
 *   失败返回明确非零退出码（invalid_config/invalid_usage → exitCode 1）；本文件的
 *   直接执行入口只是配置预检（不启动 Host、不运行场景、不写报告），供
 *   F-011 的 `scripts/acceptance/p02-accept.ts` 控制器复用同一校验面。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接
 * 运行；不调用模型，不联网，不读取用户认证/凭据，不修改任何文件。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  P02_REQUIRED_CHECKS,
  P02_REQUIRED_CHECK_IDS,
  assertValidRunId,
} from './p02-report.ts';

/* ------------------------------------------------------------------ *
 * 常量与错误
 * ------------------------------------------------------------------ */

export const P02_ACCEPT_CONFIG_VERSION = 1;
export const P02_ACCEPT_CONFIG_PATH = 'acceptance/p02.config.json';
export const P02_ACCEPT_SCRIPT_NAME = 'accept:p02';

export const P02_ACCEPT_ENV_RUN_ID = 'SHIPLOOP_ACCEPT_P02_RUN_ID';
export const P02_ACCEPT_ENV_REPORT_DIR = 'SHIPLOOP_ACCEPT_P02_REPORT_DIR';
export const P02_ACCEPT_ENV_STEP_TIMEOUT_MS = 'SHIPLOOP_ACCEPT_P02_STEP_TIMEOUT_MS';
/** 复用既有 verify 单步超时环境变量（scripts/verify.ts，契约 §3.8）。 */
export const P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS = 'SHIPLOOP_VERIFY_STEP_TIMEOUT_MS';

/** 单步/整体超时的合法范围（均为有限毫秒预算）。 */
export const P02_ACCEPT_MIN_TIMEOUT_MS = 1_000;
export const P02_ACCEPT_MAX_TIMEOUT_MS = 7_200_000;
/** 命令输出上限的合法范围（字节）。 */
export const P02_ACCEPT_MIN_OUTPUT_BYTES = 1_024;
export const P02_ACCEPT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const P02_ACCEPT_USAGE =
  `usage: ${P02_ACCEPT_SCRIPT_NAME} [--run-id <id>] [--report-dir <dir>] ` +
  '[--step-timeout-ms <ms>] [--verify-timeout-ms <ms>] [--help]\n' +
  `  --run-id <id>           指定 run-id（亦可经 ${P02_ACCEPT_ENV_RUN_ID}；缺省自动生成）\n` +
  `  --report-dir <dir>      报告根目录（亦可经 ${P02_ACCEPT_ENV_REPORT_DIR}；缺省取配置 reportRoot）\n` +
  `  --step-timeout-ms <ms>  场景步骤超时覆盖（亦可经 ${P02_ACCEPT_ENV_STEP_TIMEOUT_MS}）\n` +
  `  --verify-timeout-ms <ms> verify 步骤超时覆盖（亦可经 ${P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS}）\n` +
  `  仅提供上述报告位置与有限预算覆盖；不提供跳过认证/负例/verify 的开关。`;

const CREDENTIAL_KEY_PATTERN =
  /(?:authorization|auth|token|password|passwd|secret|credential|cookie|api[_-]?key)/i;
const SKIP_SWITCH_PATTERN = /^(?:--skip|--no-)/i;
const SKIP_LIKE_FLAGS: readonly string[] = ['--only', '--exclude', '--without', '--disable'];
const SCENARIO_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const COMMAND_ENTRY_PATTERN = /^npm run [a-z0-9][a-z0-9:._-]*$/;
const TEST_ENTRY_PATTERN = /^test\/[a-z0-9][a-z0-9./_-]*\.test\.ts$/;

export type P02AcceptErrorKind = 'invalid_config' | 'invalid_usage';

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertConfigString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_config', `${label} 必须是非空字符串`);
  }
  return value;
}

/** 配置内路径必须是仓库内 POSIX 相对路径（拒绝绝对路径与越界段）。 */
function assertConfigRelativePath(value: unknown, label: string): string {
  const path = assertConfigString(value, label);
  if (path.includes('\0') || path.startsWith('/') || path.includes('\\') || isAbsolute(path)) {
    fail('invalid_config', `${label} 必须是仓库内 POSIX 相对路径（禁止绝对路径/路径逃逸）：${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid_config', `${label} 不允许空段/./..（禁止路径逃逸）：${path}`);
  }
  return segments.join('/');
}

function assertTimeoutMs(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < P02_ACCEPT_MIN_TIMEOUT_MS ||
    value > P02_ACCEPT_MAX_TIMEOUT_MS
  ) {
    fail(
      'invalid_config',
      `${label} 必须是 ${P02_ACCEPT_MIN_TIMEOUT_MS}~${P02_ACCEPT_MAX_TIMEOUT_MS} 的整数毫秒（有限毫秒预算；拒绝非正/无限超时，收到：${String(value)}）`,
    );
  }
  return value;
}

/** 配置不解析用户认证：任何凭据形状的字段名一律拒绝。 */
function assertNoCredentialKeys(value: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      fail('invalid_config', `${label} 不得包含认证/凭据字段（配置不解析用户认证）：${key}`);
    }
  }
}

function assertAllowedConfigKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  assertNoCredentialKeys(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail('invalid_config', `${label} 含未知字段：${key}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 执行配置 Schema（acceptance/p02.config.json，configVersion=1）
 * ------------------------------------------------------------------ */

export interface P02AcceptanceTimeouts {
  /** `npm run verify` 步骤的控制器级有限超时。 */
  readonly verifyMs: number;
  /** 每个固定场景测试入口的有限超时。 */
  readonly scenarioMs: number;
  /** 阶段整体时间预算（含全部步骤）。 */
  readonly overallMs: number;
}

export type P02ScenarioKind = 'command' | 'test';

/** 稳定场景条目：必需检查 → 实际场景入口的固定映射。 */
export interface P02ScenarioDefinition {
  readonly id: string;
  readonly kind: P02ScenarioKind;
  /** 实际入口：`npm run verify` 或 test/*.test.ts（须与冻结清单一致）。 */
  readonly entry: string;
  readonly checkIds: readonly string[];
}

export interface P02AcceptanceConfig {
  readonly configVersion: number;
  /** 报告根目录（仓库内 POSIX 相对路径；CLI/env 可覆盖报告位置）。 */
  readonly reportRoot: string;
  /** 有序必需检查 ID；必须与 F-001/F-009 冻结清单完全一致（不得移除/关闭）。 */
  readonly requiredChecks: readonly string[];
  /** 稳定场景清单（有序）：每项把必需检查映射到冻结的真实场景入口。 */
  readonly scenarios: readonly P02ScenarioDefinition[];
  readonly timeouts: P02AcceptanceTimeouts;
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
    readonly applicationWireSchema: number;
    readonly eventEnvelopeSchema: number;
  };
}

const KNOWN_CHECK_IDS: ReadonlySet<string> = new Set(P02_REQUIRED_CHECK_IDS);
const FROZEN_ENTRY_BY_CHECK: ReadonlyMap<string, string> = new Map(
  P02_REQUIRED_CHECKS.map((definition) => [definition.id, definition.testEntry]),
);

function assertCheckId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_config', `${label}检查 ID 必须是非空字符串`);
  }
  const id = value as string;
  if (id.startsWith('P02-OOS-')) {
    fail(
      'invalid_config',
      `${label} 是阶段外能力（${id}）：不得列入必需检查或默认通过（阶段外能力不计入通过数）`,
    );
  }
  if (!KNOWN_CHECK_IDS.has(id)) {
    fail('invalid_config', `${label} 是未知检查 ID：${id}`);
  }
  return id;
}

function assertScenarioEntryMatchesFrozen(
  scenarioId: string,
  entry: string,
  checkIds: readonly string[],
): void {
  for (const checkId of checkIds) {
    const frozen = FROZEN_ENTRY_BY_CHECK.get(checkId) as string;
    if (entry !== frozen) {
      fail(
        'invalid_config',
        `场景 ${scenarioId} 的入口与冻结场景入口不一致（不得改写必需检查入口）：${checkId} 须映射 ${frozen}，收到 ${entry}`,
      );
    }
  }
}

/**
 * 严格校验执行配置：未知 configVersion、未知/缺失/重复检查 ID、移除或关闭必需项、
 * 非正/无限超时、报告路径逃逸、认证/凭据字段与任何未知字段一律拒绝（invalid_config）。
 * 合法配置必须完整映射 F-001（契约 §2.1）冻结清单到真实场景入口。
 */
export function validateP02AcceptanceConfig(raw: unknown): P02AcceptanceConfig {
  if (!isPlainObject(raw)) {
    fail('invalid_config', '验收配置必须是对象');
  }
  assertAllowedConfigKeys(
    raw,
    [
      'configVersion',
      'reportRoot',
      'requiredChecks',
      'scenarios',
      'timeouts',
      'maxCommandOutputBytes',
      'plan',
      'priorBaselines',
      'schemaVersions',
    ],
    '验收配置',
  );

  if (raw.configVersion !== P02_ACCEPT_CONFIG_VERSION) {
    fail(
      'invalid_config',
      `未知 configVersion：${String(raw.configVersion)}（本校验仅支持 ${P02_ACCEPT_CONFIG_VERSION}）`,
    );
  }

  const reportRoot = assertConfigRelativePath(raw.reportRoot, 'reportRoot');

  // 必需检查：恰好为冻结清单（顺序固定），缺失/重复/未知/移除/关闭/重排一律拒绝。
  if (!Array.isArray(raw.requiredChecks)) {
    fail('invalid_config', 'requiredChecks 必须是有序检查 ID 数组');
  }
  const requiredChecks = raw.requiredChecks as unknown[];
  const seenRequired = new Set<string>();
  requiredChecks.forEach((value, index) => {
    const id = assertCheckId(value, `requiredChecks[${index}]`);
    if (seenRequired.has(id)) {
      fail('invalid_config', `requiredChecks 含重复检查 ID：${id}（不得重复/顶替必需检查）`);
    }
    seenRequired.add(id);
  });
  if (requiredChecks.length !== P02_REQUIRED_CHECK_IDS.length) {
    fail(
      'invalid_config',
      `requiredChecks 必须恰好包含 ${P02_REQUIRED_CHECK_IDS.length} 个必需检查（不得移除/关闭必需项），收到 ${requiredChecks.length} 个`,
    );
  }
  requiredChecks.forEach((value, index) => {
    const expected = P02_REQUIRED_CHECK_IDS[index] as string;
    if (value !== expected) {
      fail(
        'invalid_config',
        `requiredChecks[${index}] 必须是 ${expected}（顺序固定，不得移除/关闭/重排必需检查），收到：${String(value)}`,
      );
    }
  });

  // 稳定场景清单：每项把必需检查映射到冻结的真实场景入口。
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    fail('invalid_config', 'scenarios 必须是非空数组（稳定场景清单不得为空/缺失）');
  }
  const rawScenarios = raw.scenarios as unknown[];
  const scenarios: P02ScenarioDefinition[] = [];
  const seenScenarioIds = new Set<string>();
  const mappedCheckIds: string[] = [];
  rawScenarios.forEach((entry, index) => {
    const label = `scenarios[${index}]`;
    if (!isPlainObject(entry)) {
      fail('invalid_config', `${label} 必须是对象`);
    }
    assertAllowedConfigKeys(entry, ['id', 'kind', 'entry', 'checkIds'], label);

    const id = assertConfigString(entry.id, `${label}.id`);
    if (!SCENARIO_ID_PATTERN.test(id)) {
      fail('invalid_config', `${label}.id 场景 id 非法（小写字母开头、[a-z0-9-]）：${id}`);
    }
    if (seenScenarioIds.has(id)) {
      fail('invalid_config', `场景 id 重复：${id}`);
    }
    seenScenarioIds.add(id);

    const scenarioEntry = assertConfigString(entry.entry, `${label}.entry`);

    if (!Array.isArray(entry.checkIds) || entry.checkIds.length === 0) {
      fail('invalid_config', `${label}.checkIds 至少一个检查（不得把必需检查移出场景）`);
    }
    const checkIds = (entry.checkIds as unknown[]).map((value, checkIndex) =>
      assertCheckId(value, `${label}.checkIds[${checkIndex}]`),
    );
    for (const checkId of checkIds) {
      if (mappedCheckIds.includes(checkId)) {
        fail('invalid_config', `场景清单含重复检查 ID：${checkId}（每个必需检查只映射一次）`);
      }
      mappedCheckIds.push(checkId);
    }

    const kind = entry.kind;
    if (kind !== 'command' && kind !== 'test') {
      fail('invalid_config', `${label}.kind 必须是 command|test，收到：${String(kind)}`);
    }

    scenarios.push({ id, kind, entry: scenarioEntry, checkIds });
  });

  // 逐场景：入口先与冻结清单一致（防止把必需检查改映射到伪入口而被静默关闭），
  // 再核对入口形式与 kind 一致。
  for (const scenario of scenarios) {
    assertScenarioEntryMatchesFrozen(scenario.id, scenario.entry, scenario.checkIds);
    const entryPattern = scenario.kind === 'command' ? COMMAND_ENTRY_PATTERN : TEST_ENTRY_PATTERN;
    if (!entryPattern.test(scenario.entry)) {
      fail(
        'invalid_config',
        `场景 ${scenario.id} 的 entry 与 kind ${scenario.kind} 不符（kind 必须与入口形式一致）：${scenario.entry}`,
      );
    }
  }

  // 完整映射：每个必需检查恰好映射一次，且顺序与冻结清单一致。
  for (const checkId of P02_REQUIRED_CHECK_IDS) {
    if (!mappedCheckIds.includes(checkId)) {
      fail(
        'invalid_config',
        `必需检查 ${checkId} 未映射到任何场景（不得移除/关闭必需项）`,
      );
    }
  }
  mappedCheckIds.forEach((checkId, index) => {
    const expected = P02_REQUIRED_CHECK_IDS[index] as string;
    if (checkId !== expected) {
      fail(
        'invalid_config',
        `场景检查映射顺序与冻结清单不一致（顺序固定）：位置 ${index} 应为 ${expected}，收到 ${checkId}`,
      );
    }
  });

  // 有限步骤/整体预算。
  if (!isPlainObject(raw.timeouts)) {
    fail('invalid_config', 'timeouts 必须是对象');
  }
  assertAllowedConfigKeys(raw.timeouts, ['verifyMs', 'scenarioMs', 'overallMs'], 'timeouts');
  const timeouts: P02AcceptanceTimeouts = {
    verifyMs: assertTimeoutMs(raw.timeouts.verifyMs, 'timeouts.verifyMs'),
    scenarioMs: assertTimeoutMs(raw.timeouts.scenarioMs, 'timeouts.scenarioMs'),
    overallMs: assertTimeoutMs(raw.timeouts.overallMs, 'timeouts.overallMs'),
  };
  if (timeouts.overallMs < timeouts.verifyMs || timeouts.overallMs < timeouts.scenarioMs) {
    fail(
      'invalid_config',
      `overallMs 不得小于步骤预算（整体预算须覆盖 verifyMs/scenarioMs）：${timeouts.overallMs}`,
    );
  }

  const maxCommandOutputBytes = raw.maxCommandOutputBytes;
  if (
    typeof maxCommandOutputBytes !== 'number' ||
    !Number.isInteger(maxCommandOutputBytes) ||
    maxCommandOutputBytes < P02_ACCEPT_MIN_OUTPUT_BYTES ||
    maxCommandOutputBytes > P02_ACCEPT_MAX_OUTPUT_BYTES
  ) {
    fail(
      'invalid_config',
      `maxCommandOutputBytes 必须是 ${P02_ACCEPT_MIN_OUTPUT_BYTES}~${P02_ACCEPT_MAX_OUTPUT_BYTES} 的整数（输出有大小上限），收到：${String(maxCommandOutputBytes)}`,
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
    if (!/^[0-9a-f]{40}$/.test(tipCommit)) {
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
    ['settingsSchema', 'settingsExportFormat', 'sqliteMigrations', 'applicationWireSchema', 'eventEnvelopeSchema'],
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
    configVersion: P02_ACCEPT_CONFIG_VERSION,
    reportRoot,
    requiredChecks: [...P02_REQUIRED_CHECK_IDS],
    scenarios,
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
      applicationWireSchema: assertPositiveInt(
        raw.schemaVersions.applicationWireSchema,
        'schemaVersions.applicationWireSchema',
      ),
      eventEnvelopeSchema: assertPositiveInt(
        raw.schemaVersions.eventEnvelopeSchema,
        'schemaVersions.eventEnvelopeSchema',
      ),
    },
  };
}

/** 从 JSON 文件加载并严格校验执行配置；文件缺失/不可解析同样 invalid_config。 */
export function loadP02AcceptanceConfig(configPath: string): P02AcceptanceConfig {
  if (!existsSync(configPath)) {
    fail('invalid_config', `验收配置不存在：${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    fail('invalid_config', `验收配置无法解析：${(error as Error).message}`);
  }
  return validateP02AcceptanceConfig(parsed);
}

/* ------------------------------------------------------------------ *
 * CLI / env 参数：仅报告位置与有限预算覆盖（用法错误一律拒绝）
 * ------------------------------------------------------------------ */

export interface P02AcceptOverrides {
  readonly runId?: string;
  readonly reportDir?: string;
  readonly stepTimeoutMs?: number;
  readonly verifyTimeoutMs?: number;
}

export interface P02ParsedAcceptArgs {
  readonly help: boolean;
  readonly overrides: P02AcceptOverrides;
}

/** run-id 覆盖：非法值（含路径逃逸）属用法错误，拒绝且不产生报告。 */
export function validateP02AcceptRunId(value: unknown, label = 'run-id'): string {
  try {
    return assertValidRunId(value);
  } catch (error) {
    fail('invalid_usage', `${label} 非法（禁止路径逃逸/非法字符）：${(error as Error).message}`);
  }
}

/**
 * 报告位置覆盖：允许仓库内相对路径或显式绝对路径；拒绝 NUL、反斜杠、
 * 空段/./..（路径逃逸）与文件系统根。run-id 侧的逃逸由 run-id 校验拒绝，
 * 因此 <reportRoot>/<run-id>/ 永不越出所选报告根。
 */
export function validateP02ReportDirOverride(value: unknown, label = '--report-dir'): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_usage', `${label} 非法（禁止路径逃逸）：必须是非空路径字符串`);
  }
  const path = value as string;
  if (path.includes('\0') || path.includes('\\')) {
    fail('invalid_usage', `${label} 非法（禁止路径逃逸）：含 NUL 或反斜杠`);
  }
  if (path === '/') {
    fail('invalid_usage', `${label} 非法（禁止路径逃逸）：不得为文件系统根`);
  }
  const segments = path.startsWith('/') ? path.split('/').slice(1) : path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid_usage', `${label} 非法（禁止路径逃逸）：${path}`);
  }
  return path;
}

function parseTimeoutOverride(value: string, label: string): number {
  if (!/^[0-9]+$/.test(value)) {
    fail('invalid_usage', `${label} "${value}" 必须是 ${P02_ACCEPT_MIN_TIMEOUT_MS}~${P02_ACCEPT_MAX_TIMEOUT_MS} 的整数毫秒（有限毫秒预算；拒绝非正/无限超时）`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < P02_ACCEPT_MIN_TIMEOUT_MS ||
    parsed > P02_ACCEPT_MAX_TIMEOUT_MS
  ) {
    fail('invalid_usage', `${label} "${value}" 必须是 ${P02_ACCEPT_MIN_TIMEOUT_MS}~${P02_ACCEPT_MAX_TIMEOUT_MS} 的整数毫秒（有限毫秒预算；拒绝非正/无限超时）`);
  }
  return parsed;
}

/** 解析 CLI 参数（脚本名之后的 argv）：仅 --run-id/--report-dir/两个预算覆盖与 --help。 */
export function parseP02AcceptArgs(args: readonly string[]): P02ParsedAcceptArgs {
  const overrides: {
    runId?: string;
    reportDir?: string;
    stepTimeoutMs?: number;
    verifyTimeoutMs?: number;
  } = {};

  if (args.includes('--help') || args.includes('-h')) {
    if (args.length !== 1) {
      fail('invalid_usage', '--help 只能单独使用（不与其他参数混用）');
    }
    return { help: true, overrides };
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const nextValue = (flag: string): string => {
      if (i + 1 >= args.length) {
        fail('invalid_usage', `${flag} 需要参数值`);
      }
      i += 1;
      return args[i] as string;
    };
    if (arg === '--run-id') {
      overrides.runId = validateP02AcceptRunId(nextValue('--run-id'), '--run-id');
    } else if (arg === '--report-dir') {
      overrides.reportDir = validateP02ReportDirOverride(nextValue('--report-dir'), '--report-dir');
    } else if (arg === '--step-timeout-ms') {
      overrides.stepTimeoutMs = parseTimeoutOverride(nextValue('--step-timeout-ms'), '--step-timeout-ms');
    } else if (arg === '--verify-timeout-ms') {
      overrides.verifyTimeoutMs = parseTimeoutOverride(
        nextValue('--verify-timeout-ms'),
        '--verify-timeout-ms',
      );
    } else if (SKIP_SWITCH_PATTERN.test(arg) || SKIP_LIKE_FLAGS.includes(arg)) {
      fail(
        'invalid_usage',
        `不提供跳过认证/负例/verify 的开关：${arg}（仅支持 --run-id/--report-dir/--step-timeout-ms/--verify-timeout-ms/--help）`,
      );
    } else {
      fail(
        'invalid_usage',
        `未知参数：${arg}（仅提供已记录的报告位置与有限预算覆盖：--run-id/--report-dir/--step-timeout-ms/--verify-timeout-ms/--help）`,
      );
    }
  }
  return { help: false, overrides };
}

/**
 * 读取环境变量覆盖：仅 SHIPLOOP_ACCEPT_P02_RUN_ID / _REPORT_DIR / _STEP_TIMEOUT_MS
 * 与复用的 SHIPLOOP_VERIFY_STEP_TIMEOUT_MS；未记录的 SHIPLOOP_ACCEPT_P02_*（尤其
 * 跳过类开关）一律拒绝，不静默忽略。
 */
export function readP02AcceptEnvOverrides(
  env: Readonly<Record<string, string | undefined>>,
): P02AcceptOverrides {
  const overrides: {
    runId?: string;
    reportDir?: string;
    stepTimeoutMs?: number;
    verifyTimeoutMs?: number;
  } = {};
  const known = new Set<string>([
    P02_ACCEPT_ENV_RUN_ID,
    P02_ACCEPT_ENV_REPORT_DIR,
    P02_ACCEPT_ENV_STEP_TIMEOUT_MS,
    P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS,
  ]);
  for (const name of Object.keys(env)) {
    if (!name.startsWith('SHIPLOOP_ACCEPT_P02_') || known.has(name)) {
      continue;
    }
    if (/SKIP/i.test(name)) {
      fail(
        'invalid_usage',
        `不提供跳过认证/负例/verify 的开关：${name}（仅支持 ${P02_ACCEPT_ENV_RUN_ID}/${P02_ACCEPT_ENV_REPORT_DIR}/${P02_ACCEPT_ENV_STEP_TIMEOUT_MS}/${P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS}）`,
      );
    }
    fail('invalid_usage', `未记录的环境变量：${name}（仅支持 ${[...known].join(' / ')}）`);
  }

  const envRunId = env[P02_ACCEPT_ENV_RUN_ID];
  if (envRunId !== undefined) {
    overrides.runId = validateP02AcceptRunId(envRunId, P02_ACCEPT_ENV_RUN_ID);
  }
  const envReportDir = env[P02_ACCEPT_ENV_REPORT_DIR];
  if (envReportDir !== undefined) {
    overrides.reportDir = validateP02ReportDirOverride(envReportDir, P02_ACCEPT_ENV_REPORT_DIR);
  }
  const envStepTimeout = env[P02_ACCEPT_ENV_STEP_TIMEOUT_MS];
  if (envStepTimeout !== undefined) {
    overrides.stepTimeoutMs = parseTimeoutOverride(envStepTimeout, P02_ACCEPT_ENV_STEP_TIMEOUT_MS);
  }
  const envVerifyTimeout = env[P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS];
  if (envVerifyTimeout !== undefined) {
    overrides.verifyTimeoutMs = parseTimeoutOverride(
      envVerifyTimeout,
      P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS,
    );
  }
  return overrides;
}

/* ------------------------------------------------------------------ *
 * 预检：配置 + 参数全部校验通过后才允许启动 Host 或场景
 * ------------------------------------------------------------------ */

export interface P02ResolvedInvocation {
  readonly config: P02AcceptanceConfig;
  readonly overrides: P02AcceptOverrides;
  /** 最终报告根（未覆盖时取配置 reportRoot）。 */
  readonly reportRoot: string;
  readonly configPath: string;
}

export type P02InvocationResolution =
  | { readonly ok: true; readonly help: boolean; readonly invocation: P02ResolvedInvocation | null }
  | {
      readonly ok: false;
      readonly exitCode: number;
      readonly errorKind: P02AcceptErrorKind;
      readonly message: string;
      readonly invocation?: undefined;
    };

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 在启动 Host 或任何场景之前完成配置与 CLI/env 参数校验；
 * 失败返回明确非零 exitCode（恒为 1）与错误分类，不产生任何副作用。
 * CLI 覆盖优先于环境变量覆盖。
 */
export function resolveP02AcceptInvocation(options: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configPath?: string;
  readonly repoRoot?: string;
}): P02InvocationResolution {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const configPath = options.configPath ?? resolve(repoRoot, P02_ACCEPT_CONFIG_PATH);
  try {
    const parsed = parseP02AcceptArgs(options.argv);
    if (parsed.help) {
      return { ok: true, help: true, invocation: null };
    }
    const envOverrides = readP02AcceptEnvOverrides(options.env);
    const overrides: P02AcceptOverrides = {
      ...(envOverrides.runId !== undefined ? { runId: envOverrides.runId } : {}),
      ...(envOverrides.reportDir !== undefined ? { reportDir: envOverrides.reportDir } : {}),
      ...(envOverrides.stepTimeoutMs !== undefined
        ? { stepTimeoutMs: envOverrides.stepTimeoutMs }
        : {}),
      ...(envOverrides.verifyTimeoutMs !== undefined
        ? { verifyTimeoutMs: envOverrides.verifyTimeoutMs }
        : {}),
      ...(parsed.overrides.runId !== undefined ? { runId: parsed.overrides.runId } : {}),
      ...(parsed.overrides.reportDir !== undefined ? { reportDir: parsed.overrides.reportDir } : {}),
      ...(parsed.overrides.stepTimeoutMs !== undefined
        ? { stepTimeoutMs: parsed.overrides.stepTimeoutMs }
        : {}),
      ...(parsed.overrides.verifyTimeoutMs !== undefined
        ? { verifyTimeoutMs: parsed.overrides.verifyTimeoutMs }
        : {}),
    };
    const config = loadP02AcceptanceConfig(configPath);
    return {
      ok: true,
      help: false,
      invocation: {
        config,
        overrides,
        reportRoot: overrides.reportDir ?? config.reportRoot,
        configPath,
      },
    };
  } catch (error) {
    const kind: P02AcceptErrorKind =
      error instanceof P02AcceptError ? error.kind : 'invalid_config';
    return {
      ok: false,
      exitCode: 1,
      errorKind: kind,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ------------------------------------------------------------------ *
 * 直接执行入口：仅配置预检（不启动 Host、不运行场景、不写报告）
 * ------------------------------------------------------------------ */

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

function main(argv: readonly string[]): number {
  const resolution = resolveP02AcceptInvocation({
    argv: argv.slice(2),
    env: process.env,
  });
  if (!resolution.ok) {
    err(`${P02_ACCEPT_SCRIPT_NAME}: FAIL ${resolution.message}`);
    return resolution.exitCode;
  }
  if (resolution.help) {
    out(P02_ACCEPT_USAGE);
    return 0;
  }
  const invocation = resolution.invocation as P02ResolvedInvocation;
  const { overrides } = invocation;
  out(
    `${P02_ACCEPT_SCRIPT_NAME} 预检通过：config=${P02_ACCEPT_CONFIG_PATH} ` +
      `reportRoot=${invocation.reportRoot} ` +
      `run-id=${overrides.runId ?? '<auto>'} ` +
      `stepTimeoutMs=${overrides.stepTimeoutMs ?? String(invocation.config.timeouts.scenarioMs)} ` +
      `verifyTimeoutMs=${overrides.verifyTimeoutMs ?? String(invocation.config.timeouts.verifyMs)} ` +
      `（仅校验配置与参数；Host/场景由 ${P02_ACCEPT_SCRIPT_NAME} 控制器在全部校验通过后启动）`,
  );
  return 0;
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
  process.exit(main(process.argv));
}
