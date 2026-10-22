/**
 * P04-8 / F-007 P04 集成报告聚合器（开发验收工具，不进 packages/）。
 *
 * 把三类既有交付物汇总为可重放的 P04 阶段集成报告：
 * - **步骤执行器证据**（F-003 `p04-steps.ts` 的 run.json/state.json/steps/*.json）：
 *   从磁盘按水位哈希重新装载，提供实际 argv、真实退出码、耗时与停止核验；
 * - **离线故障场景证据**（F-004/F-005/F-006 矩阵落盘 JSON）：按稳定场景 ID
 *   核对覆盖度，作为逐项断言与状态回执来源；
 * - **清单结果**（F-001 冻结清单与报告契约）：经 `p04-report.ts` 严格聚合、
 *   门禁判定与落盘重验写出报告。
 *
 * 关键行为：
 * - **逐项记录**：每个必需检查记录 pass/fail/not_run、实际命令、退出码、耗时、
 *   证据文件（hash 进 manifest）与副作用/停止核验断言；live 检查没有真实
 *   live 证据时保持 not_run，manual 检查保持 pending，离线/mock 结果不得覆盖；
 * - **工具交付 vs 阶段验收**：结果区分 `toolDelivery`（离线工具链交付完成）与
 *   `phaseGate`（阶段放行仍待 live 证据与负责人确认）；报告 openIssues/
 *   knownLimitations 明示 pending/not_run，不宣称阶段通过；
 * - **可重放、不覆盖**：同一证据可聚合出新 run-id 报告；run-id 已存在即拒绝
 *   覆盖；受测 commit、计划/清单摘要、Node/npm/Git/SQLite 与 Pi SDK 版本、
 *   脱敏输入（inputs.json 记录绑定与来源哈希）均可追溯；
 * - **fail-closed**：步骤证据缺失/哈希不符、未知退出状态、场景证据缺口、
 *   cleanup 不确定、报告写入失败均使汇总 exitCode 非零；任何失败都不修改、
 *   不删除既有步骤/场景证据目录（已完成步骤的证据全部保留）。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接
 * 运行；不调用模型、不联网。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { arch, homedir, platform, release, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  P04_ACCEPT_CONFIG_PATH,
  P04_EVIDENCE_CATEGORIES,
  P04_REQUIRED_CHECK_IDS,
  loadP04AcceptanceConfig,
  loadP04Checklist,
  validateP04AcceptanceConfig,
  type P04AcceptanceConfig,
  type P04Checklist,
  type P04EvidenceCategory,
} from './p04-config.ts';
import {
  P04ReportError,
  assertValidRunId,
  computeP04PhaseExitCode,
  generateP04RunId,
  writeP04AcceptanceReport,
  type P04AssertionRecord,
  type P04CheckResultInput,
  type P04CheckStatus,
  type P04CommandRecord,
  type P04EvidenceFileInput,
  type P04OpenIssue,
  type P04ReportVerification,
  type P04WrittenReport,
} from './p04-report.ts';
import {
  P04_STEP_EVIDENCE_SUBDIR,
  P04_STEP_LOG_SUBDIR,
  P04_STEP_RUN_MANIFEST_FILE,
  P04_STEP_STATE_FILE,
  P04_STEPS_SCHEMA_VERSION,
  type P04StepIdentity,
  type P04StepNotRunReason,
  type P04StepRecord,
} from './p04-steps.ts';

/* ------------------------------------------------------------------ *
 * 常量与错误
 * ------------------------------------------------------------------ */

export const P04_INTEGRATION_REPORT_COMPONENT = 'p04-integration-report';
export const P04_INTEGRATION_INPUTS_SCHEMA_VERSION = 1;
export const P04_PI_SDK_PACKAGE = '@earendil-works/pi-agent-core';

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export type P04IntegrationErrorKind = 'invalid_input' | 'evidence_missing' | 'evidence_corrupt';

export class P04IntegrationError extends Error {
  readonly kind: P04IntegrationErrorKind;
  readonly detail?: string;

  constructor(kind: P04IntegrationErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'P04IntegrationError';
    this.kind = kind;
    this.detail = detail;
  }
}

function fail(kind: P04IntegrationErrorKind, message: string, detail?: string): never {
  throw new P04IntegrationError(kind, message, detail);
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_input', `${label} 必须是非空字符串`);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * 步骤运行证据装载（可脱离执行器进程从磁盘重放）
 * ------------------------------------------------------------------ */

export interface P04StepRunEvidence {
  readonly evidenceDir: string;
  readonly identity: P04StepIdentity;
  readonly plannedSteps: readonly { readonly index: number; readonly id: string }[];
  /** 完整计划顺序的步骤记录（含 state 水位核验与 not_run 落盘记录）。 */
  readonly records: readonly P04StepRecord[];
  /** 已执行步骤（pass/fail）全部停止核验通过。 */
  readonly stopConfirmed: boolean;
  /** 装载期派生的问题（未知退出状态等，计入汇总失败）。 */
  readonly problems: readonly string[];
}

function stepEvidenceRelPath(index: number, stepId: string): string {
  return `${P04_STEP_EVIDENCE_SUBDIR}/${String(index + 1).padStart(2, '0')}-${stepId}.json`;
}

function stepLogRelPath(index: number, stepId: string): string {
  return `${P04_STEP_LOG_SUBDIR}/${String(index + 1).padStart(2, '0')}-${stepId}.log`;
}

function parseStepRecord(index: number, expectedStepId: string, parsed: unknown, expectedStatus?: 'pass' | 'fail'): P04StepRecord {
  if (!isPlainObject(parsed)) {
    fail('evidence_corrupt', '步骤证据必须是 JSON 对象');
  }
  if (parsed.stepId !== expectedStepId) {
    fail('evidence_corrupt', `步骤证据 stepId 与计划不一致：${String(parsed.stepId)} ≠ ${expectedStepId}`);
  }
  const status = parsed.status;
  if (status !== 'pass' && status !== 'fail' && status !== 'not_run') {
    fail('evidence_corrupt', `步骤证据 status 非法：${String(status)}`);
  }
  if (expectedStatus !== undefined && status !== expectedStatus) {
    fail('evidence_corrupt', `步骤证据与水位状态不一致：${String(status)} ≠ ${expectedStatus}`);
  }
  const notRunReason =
    status === 'not_run'
      ? typeof parsed.notRunReason === 'string'
        ? (parsed.notRunReason as P04StepNotRunReason)
        : fail('evidence_corrupt', 'not_run 步骤证据缺少 notRunReason')
      : null;
  return {
    index,
    stepId: expectedStepId,
    label: typeof parsed.label === 'string' ? parsed.label : null,
    status,
    notRunReason,
    endKind: typeof parsed.endKind === 'string' ? (parsed.endKind as P04StepRecord['endKind']) : 'unknown',
    exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
    signal: typeof parsed.signal === 'string' ? parsed.signal : null,
    timedOut: parsed.timedOut === true,
    durationMs: typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs) ? parsed.durationMs : null,
    stoppedVerified: typeof parsed.stoppedVerified === 'boolean' ? parsed.stoppedVerified : null,
    argv: Array.isArray(parsed.argv) ? (parsed.argv as unknown[]).map((entry) => String(entry)) : [],
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
    evidencePath: typeof parsed.evidencePath === 'string' ? parsed.evidencePath : stepEvidenceRelPath(index, expectedStepId),
    logPath: typeof parsed.logPath === 'string' ? parsed.logPath : null,
    fromVerifiedEvidence: true,
  };
}

function readJsonFile(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) {
    fail('evidence_missing', `${label} 缺失：${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    fail('evidence_corrupt', `${label} 无法解析：${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    fail('evidence_corrupt', `${label} 必须是 JSON 对象`);
  }
  return parsed;
}

/**
 * 从证据目录装载一次步骤运行：核对 run.json 身份与预算、state.json 水位、
 * 逐步证据与日志的存在性和 sha256。缺失/损坏/与水位不一致一律抛出
 * P04IntegrationError（evidence_missing / evidence_corrupt），不修改现场。
 */
export function loadP04StepRunEvidence(evidenceDir: string): P04StepRunEvidence {
  assertNonEmptyString(evidenceDir, 'stepRunDir');
  if (!existsSync(evidenceDir) || !statSync(evidenceDir).isDirectory()) {
    fail('evidence_missing', `步骤运行证据目录不存在：${evidenceDir}`);
  }
  const manifestPath = join(evidenceDir, P04_STEP_RUN_MANIFEST_FILE);
  const manifest = readJsonFile(manifestPath, P04_STEP_RUN_MANIFEST_FILE);
  if (manifest.schemaVersion !== P04_STEPS_SCHEMA_VERSION || manifest.component !== 'p04-steps') {
    fail('evidence_corrupt', `${P04_STEP_RUN_MANIFEST_FILE} schemaVersion/component 不符`);
  }
  const rawIdentity = manifest.identity;
  if (!isPlainObject(rawIdentity)) {
    fail('evidence_corrupt', `${P04_STEP_RUN_MANIFEST_FILE} 缺少 identity`);
  }
  if (
    typeof rawIdentity.runId !== 'string' ||
    typeof rawIdentity.commit !== 'string' ||
    !HEX_40.test(rawIdentity.commit) ||
    typeof rawIdentity.inputsDigest !== 'string' ||
    !HEX_64.test(rawIdentity.inputsDigest)
  ) {
    fail('evidence_corrupt', `${P04_STEP_RUN_MANIFEST_FILE} identity 非法`);
  }
  const identity: P04StepIdentity = {
    runId: rawIdentity.runId,
    commit: rawIdentity.commit,
    inputsDigest: rawIdentity.inputsDigest,
  };
  if (!isPlainObject(manifest.budget)) {
    fail('evidence_corrupt', `${P04_STEP_RUN_MANIFEST_FILE} 缺少 budget`);
  }
  if (!Array.isArray(manifest.plannedSteps) || manifest.plannedSteps.length === 0) {
    fail('evidence_corrupt', `${P04_STEP_RUN_MANIFEST_FILE} plannedSteps 非法`);
  }
  const plannedSteps: { index: number; id: string }[] = [];
  for (const [index, raw] of (manifest.plannedSteps as unknown[]).entries()) {
    if (!isPlainObject(raw) || raw.index !== index || typeof raw.id !== 'string') {
      fail('evidence_corrupt', `plannedSteps 第 ${index + 1} 项与顺序不符`);
    }
    plannedSteps.push({ index, id: raw.id as string });
  }

  const statePath = join(evidenceDir, P04_STEP_STATE_FILE);
  const state = readJsonFile(statePath, P04_STEP_STATE_FILE);
  if (state.schemaVersion !== P04_STEPS_SCHEMA_VERSION || state.runId !== identity.runId) {
    fail('evidence_corrupt', `${P04_STEP_STATE_FILE} schemaVersion/runId 不符`);
  }
  if (!Array.isArray(state.entries)) {
    fail('evidence_corrupt', `${P04_STEP_STATE_FILE} 缺少 entries`);
  }
  const entries = state.entries as unknown[];
  if (entries.length > plannedSteps.length) {
    fail('evidence_corrupt', `state entries 多于计划步骤：${entries.length} > ${plannedSteps.length}`);
  }

  const records: P04StepRecord[] = [];
  for (const planned of plannedSteps) {
    const entry = entries[planned.index];
    if (entry !== undefined) {
      if (!isPlainObject(entry) || entry.index !== planned.index || entry.stepId !== planned.id) {
        fail('evidence_corrupt', `state entry #${planned.index} 与计划不符`);
      }
      const status = entry.status;
      if (status !== 'pass' && status !== 'fail') {
        fail('evidence_corrupt', `state entry #${planned.index} 状态非法：${String(status)}`);
      }
      const evidenceRel =
        typeof entry.evidencePath === 'string' ? entry.evidencePath : stepEvidenceRelPath(planned.index, planned.id);
      const logRel = typeof entry.logPath === 'string' ? entry.logPath : stepLogRelPath(planned.index, planned.id);
      const evidenceAbs = join(evidenceDir, evidenceRel);
      if (!existsSync(evidenceAbs)) {
        fail('evidence_missing', `步骤证据缺失：${evidenceRel}`);
      }
      const content = readFileSync(evidenceAbs, 'utf-8');
      if (sha256Hex(content) !== entry.evidenceSha256) {
        fail('evidence_corrupt', `步骤证据哈希与水位不符（证据损坏）：${evidenceRel}`);
      }
      const record = parseStepRecord(planned.index, planned.id, JSON.parse(content), status);
      const logAbs = join(evidenceDir, logRel);
      if (!existsSync(logAbs)) {
        fail('evidence_missing', `步骤日志缺失：${logRel}`);
      }
      if (sha256Hex(readFileSync(logAbs, 'utf-8')) !== entry.logSha256) {
        fail('evidence_corrupt', `步骤日志哈希与水位不符（证据损坏）：${logRel}`);
      }
      records.push(record);
    } else {
      const evidenceRel = stepEvidenceRelPath(planned.index, planned.id);
      const evidenceAbs = join(evidenceDir, evidenceRel);
      if (!existsSync(evidenceAbs)) {
        fail('evidence_missing', `步骤证据缺失：${evidenceRel}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(evidenceAbs, 'utf-8'));
      } catch (error) {
        fail('evidence_corrupt', `not_run 步骤证据无法解析：${evidenceRel}：${(error as Error).message}`);
      }
      records.push(parseStepRecord(planned.index, planned.id, parsed, undefined));
    }
  }

  // 运行器门禁复核：pass 必须 exit/0/停止核验；未知退出状态不伪造结果。
  const problems: string[] = [];
  for (const record of records) {
    if (record.status === 'pass' && (record.endKind !== 'exit' || record.exitCode !== 0 || record.stoppedVerified !== true)) {
      fail('evidence_corrupt', `pass 步骤证据不满足运行器门禁（证据损坏）：${record.stepId}`);
    }
    if (record.endKind === 'unknown' || (record.status !== 'not_run' && record.exitCode === null)) {
      problems.push(`步骤 ${record.stepId} 未知退出状态（endKind=${record.endKind}，退出码 ${String(record.exitCode)}），不伪造 0/1`);
    }
  }
  const executed = records.filter((record) => record.status !== 'not_run');
  const stopConfirmed = executed.every((record) => record.stoppedVerified === true);

  const summary = manifest.summary;
  if (summary !== undefined) {
    if (!isPlainObject(summary)) {
      fail('evidence_corrupt', `${P04_STEP_RUN_MANIFEST_FILE} summary 非法`);
    }
    const counts = summary.counts;
    const expectedCounts = {
      pass: records.filter((record) => record.status === 'pass').length,
      fail: records.filter((record) => record.status === 'fail').length,
      not_run: records.filter((record) => record.status === 'not_run').length,
    };
    if (
      !isPlainObject(counts) ||
      counts.pass !== expectedCounts.pass ||
      counts.fail !== expectedCounts.fail ||
      counts.not_run !== expectedCounts.not_run ||
      summary.stopConfirmed !== stopConfirmed
    ) {
      fail('evidence_corrupt', `${P04_STEP_RUN_MANIFEST_FILE} summary 与证据重放结果不一致`);
    }
  }

  return {
    evidenceDir,
    identity,
    plannedSteps,
    records,
    stopConfirmed,
    problems: Object.freeze(problems),
  };
}

/* ------------------------------------------------------------------ *
 * 场景证据装载
 * ------------------------------------------------------------------ */

interface LoadedScenario {
  readonly file: string;
  readonly ok: boolean;
  readonly text: string | null;
  readonly sha256: string | null;
  readonly sizeBytes: number;
  /** 文件内观察到的稳定场景 ID（无 observations 结构时为 null）。 */
  readonly observed: ReadonlySet<string> | null;
  readonly problem: string | null;
}

function loadScenarioFile(scenarioRoot: string, file: string): LoadedScenario {
  const path = join(scenarioRoot, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { file, ok: false, text: null, sha256: null, sizeBytes: 0, observed: null, problem: '场景证据文件缺失' };
  }
  const text = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { file, ok: false, text: null, sha256: null, sizeBytes: 0, observed: null, problem: `无法解析：${(error as Error).message}` };
  }
  if (!isPlainObject(parsed)) {
    return { file, ok: false, text: null, sha256: null, sizeBytes: 0, observed: null, problem: '必须是 JSON 对象' };
  }
  if (typeof parsed.schemaVersion !== 'number' || parsed.offline !== true) {
    return { file, ok: false, text: null, sha256: null, sizeBytes: 0, observed: null, problem: '缺少 schemaVersion/offline=true（不是离线矩阵证据）' };
  }
  const live = parsed.live;
  const liveNotRun = live === 'not_run' || (isPlainObject(live) && live.status === 'not_run');
  if (!liveNotRun) {
    return { file, ok: false, text: null, sha256: null, sizeBytes: 0, observed: null, problem: 'live 字段必须为 not_run（离线矩阵不得冒充真实调用）' };
  }
  let observed: Set<string> | null = null;
  if (Array.isArray(parsed.observations)) {
    observed = new Set<string>();
    for (const row of parsed.observations as unknown[]) {
      if (isPlainObject(row) && typeof row.scenarioId === 'string') observed.add(row.scenarioId);
    }
  }
  return { file, ok: true, text, sha256: sha256Hex(text), sizeBytes: Buffer.byteLength(text), observed, problem: null };
}

/* ------------------------------------------------------------------ *
 * 聚合选项与结果
 * ------------------------------------------------------------------ */

export interface P04ScenarioEvidenceSpec {
  /** 场景证据文件名（相对 scenarioRoot）。 */
  readonly file: string;
  /** 证据类别：必须反映文件真实内容（用于满足清单类别覆盖）。 */
  readonly category: P04EvidenceCategory;
  /** 该文件必须覆盖的稳定场景 ID；空/缺省表示仅作为证据记录。 */
  readonly scenarioIds?: readonly string[];
}

export interface P04ExtraEvidenceSpec {
  readonly name: string;
  readonly category: P04EvidenceCategory;
  readonly content: string;
}

export interface P04IntegrationCheckBinding {
  readonly checkId: string;
  /** 支撑该检查的步骤 ID（须存在于步骤运行计划）。 */
  readonly stepIds?: readonly string[];
  readonly scenarios?: readonly P04ScenarioEvidenceSpec[];
  /** 额外固定证据（如 zero-call 证明、结构化事实）。 */
  readonly extraEvidence?: readonly P04ExtraEvidenceSpec[];
}

export interface P04ManualConfirmation {
  readonly checkId: string;
  /** 负责人身份（报告与证据中留档；模型不得代签）。 */
  readonly signer: string;
  readonly confirmedAtUtc: string;
  readonly conclusion: 'confirmed' | 'rejected';
  /** 负责人确认的副作用/交付核对结论。 */
  readonly sideEffectVerified: boolean;
  readonly note?: string;
}

export interface P04LiveRunInput {
  readonly checkId: string;
  /** 真实 live 运行的脱敏证据内容（落盘为 live 类别证据）。 */
  readonly evidenceContent: string;
  readonly assertions: readonly P04AssertionRecord[];
  readonly sideEffectVerified: boolean;
  readonly detail?: string;
}

export interface P04IntegrationReportOptions {
  readonly repoRoot: string;
  /** 报告 run-id；缺省按当前 UTC 时间生成。 */
  readonly runId?: string;
  /** 报告根目录；缺省使用配置 reportRoot（相对 repoRoot）。 */
  readonly reportRoot?: string;
  readonly checklist?: P04Checklist;
  readonly config?: P04AcceptanceConfig;
  /** F-003 步骤运行证据目录。 */
  readonly stepRunDir: string;
  /** 场景证据目录（绑定含场景时必填）。 */
  readonly scenarioRoot?: string;
  readonly bindings: readonly P04IntegrationCheckBinding[];
  readonly manualConfirmations?: readonly P04ManualConfirmation[];
  readonly liveRuns?: readonly P04LiveRunInput[];
  /** 产品 Feature 执行报告引用（阶段报告与产品报告分层可追溯）。 */
  readonly productReports?: readonly { featureId: string; label: string; command: string; content: string }[];
  /** 外部 cleanup 事实（来自实际核验，不来自目录删除）。 */
  readonly cleanup?: { confirmed: boolean; processesGone: boolean; notes?: readonly string[] };
  readonly knownLimitations?: readonly string[];
  readonly openIssues?: readonly P04OpenIssue[];
  /** 额外敏感值：写入前统一脱敏。 */
  readonly sensitiveValues?: readonly string[];
  /** 命令检测注入（git/npm/版本探测）；缺省真实执行有限时长的只读命令。 */
  readonly exec?: (command: string, args: readonly string[]) => string;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export interface P04IntegrationCoverage {
  readonly scenariosExpected: number;
  readonly scenariosCovered: number;
  readonly missingScenarioIds: readonly string[];
  readonly stepsPlanned: number;
  readonly stepsVerified: number;
}

export interface P04PhaseGateStatus {
  /** 阶段验收结论（live/manual/清理/证据全部齐备且门禁通过才为 true）。 */
  readonly accepted: boolean;
  readonly pending: readonly {
    readonly checkId: string;
    readonly kind: 'live' | 'manual';
    readonly display: 'not_run' | 'pending';
  }[];
}

export interface P04IntegrationReportResult {
  readonly runId: string;
  /** 0 仅当报告写出且重验通过、阶段结论 pass、cleanup 确认且无任何汇总问题。 */
  readonly exitCode: number;
  readonly reportWritten: boolean;
  readonly written: P04WrittenReport | null;
  readonly verification: P04ReportVerification | null;
  readonly conclusion: 'pass' | 'fail' | null;
  /** 离线工具链交付状态（不含 live/manual 阶段门槛）。 */
  readonly toolDelivery: { readonly status: 'pass' | 'fail'; readonly problemCount: number };
  readonly phaseGate: P04PhaseGateStatus;
  readonly coverage: P04IntegrationCoverage;
  readonly problems: readonly string[];
}

/* ------------------------------------------------------------------ *
 * 辅助：脱敏、工具链与 git 事实
 * ------------------------------------------------------------------ */

function makeSanitizer(
  repoRoot: string,
  stepRunDir: string,
  scenarioRoot: string | null,
): (text: string) => string {
  const pairs: readonly (readonly [string, string])[] = [
    [repoRoot, '<repo>'],
    [stepRunDir, '<step-run>'],
    ...(scenarioRoot === null ? ([] as const) : ([[scenarioRoot, '<scenarios>']] as const)),
    [homedir(), '<home>'],
    [tmpdir(), '<temp>'],
  ];
  return (text) => {
    let out = text;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out.replace(/\/(?:Users|home)\/[^/\s"'`,;:|)\\]+/g, '<home>');
  };
}

function toLogicalLocation(sanitize: (text: string) => string, value: string): string {
  const out = sanitize(value);
  return out.startsWith('/') ? '<external>' : out;
}

function packageVersionOf(repoRoot: string, packageName: string): string {
  try {
    const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
    const manifest = requireFromRepo(`${packageName}/package.json`) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function declaredVersionOf(repoRoot: string, packageName: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface ToolchainFacts {
  readonly node: string;
  readonly npm: string;
  readonly git: string;
  readonly sqlite: string;
  readonly betterSqlite3: string;
  readonly drizzleOrm: string;
  readonly sdkVersion: string;
  readonly sdkPackage: string;
}

function detectToolchain(repoRoot: string, exec: (command: string, args: readonly string[]) => string): ToolchainFacts {
  const safe = (command: string, args: readonly string[], fallback: string): string => {
    try {
      return exec(command, args) || fallback;
    } catch {
      return fallback;
    }
  };
  return {
    node: safe('node', ['--version'], process.version),
    npm: safe('npm', ['--version'], 'unknown'),
    git: safe('git', ['--version'], 'unknown'),
    sqlite: safe('sqlite3', ['--version'], 'unknown'),
    betterSqlite3: packageVersionOf(repoRoot, 'better-sqlite3'),
    drizzleOrm: packageVersionOf(repoRoot, 'drizzle-orm'),
    sdkVersion: declaredVersionOf(repoRoot, P04_PI_SDK_PACKAGE),
    sdkPackage: P04_PI_SDK_PACKAGE,
  };
}

function mapStepNotRunReason(reason: P04StepNotRunReason | null): P04CheckResultInput['notRunReason'] {
  if (reason === 'budget_exhausted') return 'timeout';
  if (reason === 'evidence_write_failed') return 'missing_output';
  return 'skipped';
}

/* ------------------------------------------------------------------ *
 * 主入口：聚合并写出 P04 集成报告
 * ------------------------------------------------------------------ */

function pendingFromChecklist(
  checklist: P04Checklist,
  statusOf: (checkId: string) => { status: P04CheckStatus; manualPending: boolean },
): P04PhaseGateStatus['pending'] {
  const pending: { checkId: string; kind: 'live' | 'manual'; display: 'not_run' | 'pending' }[] = [];
  for (const item of checklist.items) {
    if (item.group === 'deferred') continue;
    if (item.execution === 'live' && statusOf(item.id).status !== 'pass') {
      pending.push({ checkId: item.id, kind: 'live', display: 'not_run' });
    }
    if (item.execution === 'manual' && statusOf(item.id).manualPending) {
      pending.push({ checkId: item.id, kind: 'manual', display: 'pending' });
    }
  }
  return pending;
}

export function aggregateP04IntegrationReport(options: P04IntegrationReportOptions): P04IntegrationReportResult {
  if (!isPlainObject(options)) {
    fail('invalid_input', '聚合选项必须是对象');
  }
  assertNonEmptyString(options.repoRoot, 'repoRoot');
  assertNonEmptyString(options.stepRunDir, 'stepRunDir');
  if (!existsSync(options.repoRoot) || !statSync(options.repoRoot).isDirectory()) {
    fail('invalid_input', `repoRoot 不存在或不是目录：${options.repoRoot}`);
  }
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const config = options.config ?? loadP04AcceptanceConfig(join(options.repoRoot, P04_ACCEPT_CONFIG_PATH));
  validateP04AcceptanceConfig(config);
  const checklist = options.checklist ?? loadP04Checklist(join(options.repoRoot, config.checklist));
  const requiredItems = checklist.items.filter((item) => item.group !== 'deferred');
  const requiredById = new Map(requiredItems.map((item) => [item.id, item]));
  if (requiredItems.map((item) => item.id).join('\u0000') !== P04_REQUIRED_CHECK_IDS.join('\u0000')) {
    fail('invalid_input', '清单必需检查与冻结 P04_REQUIRED_CHECK_IDS 不一致');
  }

  const runId = assertValidRunId(options.runId ?? generateP04RunId(now(), randomBytes(4).toString('hex')));

  // 绑定校验：未知/重复检查、live/manual 不得绑定离线步骤/场景（mock 不覆盖）。
  const bindingsById = new Map<string, P04IntegrationCheckBinding>();
  const scenarioFilesNeeded = new Set<string>();
  for (const binding of options.bindings ?? []) {
    if (!isPlainObject(binding) || typeof binding.checkId !== 'string') {
      fail('invalid_input', '绑定必须是含 checkId 的对象');
    }
    const item = requiredById.get(binding.checkId);
    if (item === undefined) {
      fail('invalid_input', `绑定引用未知/非必需检查 ID：${binding.checkId}`);
    }
    if (bindingsById.has(binding.checkId)) {
      fail('invalid_input', `绑定的 checkId 重复：${binding.checkId}`);
    }
    const hasOfflineSources =
      (binding.stepIds?.length ?? 0) > 0 || (binding.scenarios?.length ?? 0) > 0 || (binding.extraEvidence?.length ?? 0) > 0;
    if ((item.execution === 'live' || item.execution === 'manual') && hasOfflineSources) {
      fail(
        'invalid_input',
        `${binding.checkId} 是 ${item.execution} 检查：不得绑定离线步骤/场景/额外证据顶替（真实 ${item.execution} 结果不被 mock 覆盖）`,
      );
    }
    for (const spec of binding.scenarios ?? []) {
      if (!isPlainObject(spec) || typeof spec.file !== 'string' || spec.file.length === 0) {
        fail('invalid_input', `${binding.checkId} 的场景规格缺少 file`);
      }
      if (!P04_EVIDENCE_CATEGORIES.includes(spec.category as never)) {
        fail('invalid_input', `${binding.checkId} 的场景证据类别非法：${String(spec.category)}`);
      }
      scenarioFilesNeeded.add(spec.file);
    }
    for (const extra of binding.extraEvidence ?? []) {
      if (!isPlainObject(extra) || typeof extra.name !== 'string' || extra.name.length === 0) {
        fail('invalid_input', `${binding.checkId} 的额外证据缺少 name`);
      }
      if (!P04_EVIDENCE_CATEGORIES.includes(extra.category as never)) {
        fail('invalid_input', `${binding.checkId} 的额外证据类别非法：${String(extra.category)}`);
      }
      if (typeof extra.content !== 'string') {
        fail('invalid_input', `${binding.checkId} 的额外证据 content 必须是字符串`);
      }
    }
    bindingsById.set(binding.checkId, binding);
  }
  for (const live of options.liveRuns ?? []) {
    const item = requiredById.get(live.checkId);
    if (item === undefined || item.execution !== 'live') {
      fail('invalid_input', `liveRuns 引用非 live 检查：${String(live.checkId)}`);
    }
  }
  for (const confirmation of options.manualConfirmations ?? []) {
    const item = requiredById.get(confirmation.checkId);
    if (item === undefined || item.execution !== 'manual') {
      fail('invalid_input', `manualConfirmations 引用非 manual 检查：${String(confirmation.checkId)}`);
    }
    assertNonEmptyString(confirmation.signer, `${confirmation.checkId} 的 signer`);
    if (typeof confirmation.confirmedAtUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(confirmation.confirmedAtUtc)) {
      fail('invalid_input', `${confirmation.checkId} 的 confirmedAtUtc 必须是 ISO 8601 UTC 时间`);
    }
  }
  if (scenarioFilesNeeded.size > 0 && (options.scenarioRoot === undefined || options.scenarioRoot.length === 0)) {
    fail('invalid_input', '绑定包含场景证据但缺少 scenarioRoot');
  }

  const scenarioRoot = options.scenarioRoot ?? null;
  const sanitize = makeSanitizer(options.repoRoot, options.stepRunDir, scenarioRoot);

  const emptyCoverage: P04IntegrationCoverage = {
    scenariosExpected: 0,
    scenariosCovered: 0,
    missingScenarioIds: [],
    stepsPlanned: 0,
    stepsVerified: 0,
  };

  // 1) 步骤运行证据：装载失败即 fail-closed（不写报告、不动现场）。
  let stepEvidence: P04StepRunEvidence;
  try {
    stepEvidence = loadP04StepRunEvidence(options.stepRunDir);
  } catch (error) {
    if (!(error instanceof P04IntegrationError)) throw error;
    return {
      runId,
      exitCode: 1,
      reportWritten: false,
      written: null,
      verification: null,
      conclusion: null,
      toolDelivery: { status: 'fail', problemCount: 1 },
      phaseGate: {
        accepted: false,
        pending: pendingFromChecklist(checklist, () => ({ status: 'not_run', manualPending: true })),
      },
      coverage: emptyCoverage,
      problems: [`步骤运行证据装载失败（${error.kind}）：${error.message}`],
    };
  }

  const problems: string[] = [...stepEvidence.problems];
  const toolProblems: string[] = [...stepEvidence.problems];
  const missingScenarioIds: string[] = [];
  let scenariosExpected = 0;
  let scenariosCovered = 0;

  // 2) 场景证据装载。
  const scenarioByName = new Map<string, LoadedScenario>();
  for (const file of scenarioFilesNeeded) {
    const loaded = loadScenarioFile(scenarioRoot as string, file);
    scenarioByName.set(file, loaded);
    if (!loaded.ok) {
      problems.push(`场景证据不可用：${file} — ${loaded.problem ?? '未知问题'}`);
      toolProblems.push(`场景证据不可用：${file} — ${loaded.problem ?? '未知问题'}`);
    }
  }

  // 3) 逐检查装配结果与证据。
  const results: P04CheckResultInput[] = [];
  const evidenceFiles: P04EvidenceFileInput[] = [];
  const livePending: string[] = [];
  const manualPending: string[] = [];
  const checkStatusById = new Map<string, { status: P04CheckStatus; manualPending: boolean }>();

  for (const item of requiredItems) {
    const binding = bindingsById.get(item.id);
    const refs: string[] = [];

    if (item.execution === 'live') {
      const liveInput = (options.liveRuns ?? []).find((entry) => entry.checkId === item.id) ?? null;
      const statusRef = `evidence/checks/${item.id}/live.json`;
      if (liveInput === null) {
        const pendingContent = `${JSON.stringify(
          {
            component: P04_INTEGRATION_REPORT_COMPONENT,
            checkId: item.id,
            execution: 'live',
            status: 'not_run',
            reason: '真实 Pi live 验收未获授权执行（zero-call 保持）；不被离线/mock 结果覆盖',
          },
          null,
          2,
        )}\n`;
        evidenceFiles.push({ path: statusRef, category: 'live', checkId: item.id, content: pendingContent, capturedBeforeCleanup: true });
        results.push({
          checkId: item.id,
          status: 'not_run',
          notRunReason: 'skipped',
          execution: item.execution,
          executionMode: 'fake',
          detail: '真实 live 验收未运行（未获授权或缺认证保持 zero-call not_run）；不被离线/mock 结果覆盖',
          evidenceRefs: [statusRef],
        });
        livePending.push(item.id);
        checkStatusById.set(item.id, { status: 'not_run', manualPending: false });
        continue;
      }
      const assertions = liveInput.assertions.map((entry) => ({ id: entry.id, satisfied: entry.satisfied }));
      const passCandidate = assertions.length > 0 && assertions.every((entry) => entry.satisfied) && liveInput.sideEffectVerified;
      evidenceFiles.push({ path: statusRef, category: 'live', checkId: item.id, content: liveInput.evidenceContent, capturedBeforeCleanup: true });
      refs.push(statusRef);
      const resultRef = `evidence/checks/${item.id}/result.json`;
      evidenceFiles.push({
        path: resultRef,
        category: 'report',
        checkId: item.id,
        content: `${JSON.stringify({ component: P04_INTEGRATION_REPORT_COMPONENT, checkId: item.id, status: passCandidate ? 'pass' : 'fail', assertions }, null, 2)}\n`,
        capturedBeforeCleanup: true,
      });
      refs.push(resultRef);
      if (!passCandidate) livePending.push(item.id);
      results.push({
        checkId: item.id,
        status: passCandidate ? 'pass' : 'fail',
        execution: item.execution,
        executionMode: 'live',
        assertions,
        sideEffectVerified: liveInput.sideEffectVerified,
        detail: liveInput.detail ?? '真实 live 运行结果（证据见 live.json）',
        evidenceRefs: refs,
      });
      checkStatusById.set(item.id, { status: passCandidate ? 'pass' : 'fail', manualPending: false });
      continue;
    }

    if (item.execution === 'manual') {
      const confirmation =
        (options.manualConfirmations ?? []).find((entry) => entry.checkId === item.id) ?? null;
      const statusRef = `evidence/checks/${item.id}/manual.json`;
      const manualStatus = confirmation === null ? 'pending' : confirmation.conclusion === 'confirmed' ? 'confirmed' : 'rejected';
      const confirmationRecord = {
        component: P04_INTEGRATION_REPORT_COMPONENT,
        checkId: item.id,
        execution: 'manual',
        manualStatus,
        ...(confirmation === null
          ? { reason: '人工验收待负责人确认（pending）；工具不代签放行' }
          : { signer: confirmation.signer, confirmedAtUtc: confirmation.confirmedAtUtc, conclusion: confirmation.conclusion, sideEffectVerified: confirmation.sideEffectVerified, ...(confirmation.note === undefined ? {} : { note: confirmation.note }) }),
      };
      evidenceFiles.push({
        path: statusRef,
        category: 'manual',
        checkId: item.id,
        content: `${JSON.stringify(confirmationRecord, null, 2)}\n`,
        capturedBeforeCleanup: true,
      });
      refs.push(statusRef);
      const resultRef = `evidence/checks/${item.id}/result.json`;
      const status: P04CheckStatus = manualStatus === 'confirmed' && confirmation?.sideEffectVerified === true ? 'pass' : manualStatus === 'rejected' ? 'fail' : 'not_run';
      const assertions =
        manualStatus === 'confirmed'
          ? [{ id: `owner-confirmed:${confirmation!.signer}`, satisfied: true }]
          : [];
      evidenceFiles.push({
        path: resultRef,
        category: 'report',
        checkId: item.id,
        content: `${JSON.stringify({ ...confirmationRecord, component: P04_INTEGRATION_REPORT_COMPONENT, checkId: item.id, status }, null, 2)}\n`,
        capturedBeforeCleanup: true,
      });
      refs.push(resultRef);
      if (item.evidence.includes('manifest')) {
        const manifestRef = `evidence/checks/${item.id}/manifest.json`;
        evidenceFiles.push({
          path: manifestRef,
          category: 'manifest',
          checkId: item.id,
          content: `${JSON.stringify({ component: P04_INTEGRATION_REPORT_COMPONENT, checkId: item.id, capturedFiles: refs, capturedBeforeCleanup: true }, null, 2)}\n`,
          capturedBeforeCleanup: true,
        });
        refs.push(manifestRef);
      }
      if (manualStatus !== 'confirmed' || status !== 'pass') manualPending.push(item.id);
      results.push({
        checkId: item.id,
        status,
        ...(status === 'not_run' ? { notRunReason: 'skipped' as const } : {}),
        execution: item.execution,
        executionMode: 'fake',
        ...(manualStatus === 'pending' || manualStatus === 'confirmed' || manualStatus === 'rejected'
          ? { manualStatus: manualStatus as 'pending' | 'confirmed' | 'rejected' }
          : {}),
        ...(assertions.length > 0 ? { assertions } : {}),
        ...(manualStatus === 'confirmed' ? { sideEffectVerified: confirmation!.sideEffectVerified } : {}),
        detail:
          manualStatus === 'pending'
            ? '人工验收待负责人确认（pending）；工具不代签放行'
            : `${manualStatus === 'confirmed' ? '负责人已确认' : '负责人驳回'}：${confirmation!.signer} @ ${confirmation!.confirmedAtUtc}`,
        evidenceRefs: refs,
      });
      checkStatusById.set(item.id, { status, manualPending: manualStatus === 'pending' });
      continue;
    }

    // offline：步骤 + 场景 + 额外证据。
    const assertions: P04AssertionRecord[] = [];
    let anyStepFail = false;
    let anyStepNotRun: P04CheckResultInput['notRunReason'] | null = null;
    let stepsPass = (binding?.stepIds?.length ?? 0) > 0;
    let stepCount = 0;
    let stepPassCount = 0;
    let durationTotal = 0;
    let durationKnown = true;
    for (const stepId of binding?.stepIds ?? []) {
      const record = stepEvidence.records.find((entry) => entry.stepId === stepId);
      stepCount += 1;
      if (record === undefined) {
        problems.push(`${item.id}: 绑定步骤不存在于运行证据：${stepId}`);
        toolProblems.push(`${item.id}: 绑定步骤不存在于运行证据：${stepId}`);
        assertions.push({ id: `step:${stepId}:exit-0-stop-verified`, satisfied: false });
        anyStepFail = true;
        stepsPass = false;
        continue;
      }
      const ref = `evidence/checks/${item.id}/steps/${basename(record.evidencePath)}`;
      evidenceFiles.push({
        path: ref,
        category: 'command-exit',
        checkId: item.id,
        content: readFileSync(join(options.stepRunDir, record.evidencePath), 'utf-8'),
        capturedBeforeCleanup: true,
      });
      refs.push(ref);
      assertions.push({ id: `step:${stepId}:exit-0-stop-verified`, satisfied: record.status === 'pass' });
      if (record.status === 'pass') {
        stepPassCount += 1;
        if (record.durationMs === null) durationKnown = false;
        else durationTotal += record.durationMs;
      } else if (record.status === 'fail') {
        anyStepFail = true;
        stepsPass = false;
      } else {
        stepsPass = false;
        anyStepNotRun = mapStepNotRunReason(record.notRunReason);
      }
    }

    let scenariosOk = true;
    let hasScenarios = false;
    for (const spec of binding?.scenarios ?? []) {
      hasScenarios = true;
      const loaded = scenarioByName.get(spec.file) as LoadedScenario;
      const ref = `evidence/checks/${item.id}/scenarios/${spec.file}`;
      if (loaded.ok) {
        evidenceFiles.push({
          path: ref,
          category: spec.category,
          checkId: item.id,
          content: loaded.text as string,
          capturedBeforeCleanup: true,
        });
      } else {
        evidenceFiles.push({
          path: ref,
          category: spec.category,
          checkId: item.id,
          content: `${JSON.stringify({ component: P04_INTEGRATION_REPORT_COMPONENT, checkId: item.id, file: spec.file, problem: loaded.problem }, null, 2)}\n`,
          capturedBeforeCleanup: true,
        });
        scenariosOk = false;
      }
      refs.push(ref);
      const expectedIds = spec.scenarioIds ?? [];
      if (expectedIds.length === 0) {
        assertions.push({ id: `scenario:${spec.file}:present`, satisfied: loaded.ok });
        if (!loaded.ok) scenariosOk = false;
        continue;
      }
      for (const scenarioId of expectedIds) {
        scenariosExpected += 1;
        const hit = loaded.ok && (loaded.observed?.has(scenarioId) ?? false);
        if (hit) scenariosCovered += 1;
        else if (!missingScenarioIds.includes(scenarioId)) missingScenarioIds.push(scenarioId);
        assertions.push({ id: `scenario:${spec.file}:${scenarioId}`, satisfied: hit });
        if (!hit) scenariosOk = false;
      }
    }
    if (!hasScenarios && stepCount === 0) {
      problems.push(`${item.id}: 未绑定任何执行来源（offline 检查需要步骤或场景证据）`);
      toolProblems.push(`${item.id}: 未绑定任何执行来源`);
    }

    for (const extra of binding?.extraEvidence ?? []) {
      const ref = `evidence/checks/${item.id}/extra/${extra.name}`;
      evidenceFiles.push({ path: ref, category: extra.category, checkId: item.id, content: extra.content, capturedBeforeCleanup: true });
      refs.push(ref);
    }

    const status: P04CheckStatus =
      anyStepFail || !scenariosOk ? 'fail' : anyStepNotRun !== null || (stepCount === 0 && !hasScenarios) ? 'not_run' : stepsPass ? 'pass' : 'fail';
    const detail =
      `步骤 ${stepPassCount}/${stepCount} 通过；场景 ${assertions.filter((entry) => entry.id.startsWith('scenario:') && entry.satisfied).length}/${assertions.filter((entry) => entry.id.startsWith('scenario:')).length} 覆盖` +
      (status === 'pass' ? '；停止核验与副作用断言见证据' : anyStepFail ? '；存在失败步骤' : '');

    const resultRef = `evidence/checks/${item.id}/result.json`;
    evidenceFiles.push({
      path: resultRef,
      category: 'report',
      checkId: item.id,
      content: `${JSON.stringify({ component: P04_INTEGRATION_REPORT_COMPONENT, checkId: item.id, status, assertions, detail }, null, 2)}\n`,
      capturedBeforeCleanup: true,
    });
    refs.push(resultRef);
    if (item.evidence.includes('manifest')) {
      const manifestRef = `evidence/checks/${item.id}/manifest.json`;
      evidenceFiles.push({
        path: manifestRef,
        category: 'manifest',
        checkId: item.id,
        content: `${JSON.stringify({ component: P04_INTEGRATION_REPORT_COMPONENT, checkId: item.id, capturedFiles: refs, capturedBeforeCleanup: true }, null, 2)}\n`,
        capturedBeforeCleanup: true,
      });
      refs.push(manifestRef);
    }

    results.push({
      checkId: item.id,
      status,
      ...(status === 'not_run' ? { notRunReason: anyStepNotRun ?? 'missing_result' } : {}),
      execution: item.execution,
      executionMode: 'fake',
      assertions,
      ...(status === 'pass' ? { sideEffectVerified: true } : status === 'fail' ? { sideEffectVerified: false } : {}),
      ...(durationKnown && stepCount > 0 ? { durationMs: durationTotal } : {}),
      detail,
      evidenceRefs: refs,
    });
    checkStatusById.set(item.id, { status, manualPending: false });
  }

  // 4) cleanup 事实（来自调用方实际核验；不确定即 fail-closed）。
  const callerCleanup = options.cleanup;
  const processesGone = stepEvidence.stopConfirmed && (callerCleanup?.processesGone ?? true);
  const cleanupConfirmed = callerCleanup?.confirmed === true && processesGone;
  if (callerCleanup === undefined) {
    problems.push('cleanup: 缺少外部清理确认事实，按不确定处理（fail-closed）');
    toolProblems.push('cleanup: 缺少外部清理确认事实');
  }
  if (callerCleanup !== undefined && !callerCleanup.confirmed) {
    problems.push('cleanup: 临时资源清理未确认（confirmed=false）');
  }
  if (!processesGone) {
    problems.push('cleanup: 受管进程组未确认消失，清理不确定');
  }
  const cleanupNotes = [
    ...(callerCleanup?.notes ?? []),
    ...(cleanupConfirmed ? [] : ['cleanup 不确定：按 fail-closed 处理，已完成步骤证据保留现场']),
  ];

  // 5) 工具链与 git 事实。
  const exec = options.exec ?? ((command: string, args: readonly string[]) =>
    execFileSync(command, [...args], { cwd: options.repoRoot, encoding: 'utf-8', timeout: 10_000 }).trim());
  const toolchain = detectToolchain(options.repoRoot, exec);
  const safeGit = (args: readonly string[], fallback: string | null): string | null => {
    try {
      return exec('git', args) || fallback;
    } catch {
      return fallback;
    }
  };
  const headCommit = safeGit(['rev-parse', 'HEAD'], null);
  if (headCommit === null || !HEX_40.test(headCommit)) {
    problems.push('git: 无法取得当前仓库 HEAD');
    toolProblems.push('git: 无法取得当前仓库 HEAD');
  }
  const gitHeadDrift = headCommit !== null && headCommit !== stepEvidence.identity.commit;
  const worktreeRaw = safeGit(['status', '--porcelain'], null);
  const worktree = worktreeRaw === null ? 'dirty' : worktreeRaw === '' ? 'clean' : 'dirty';
  const branchRaw = safeGit(['branch', '--show-current'], null);
  const branch = branchRaw === null || branchRaw === '' ? null : branchRaw;
  const treeHash = safeGit(['rev-parse', 'HEAD^{tree}'], null);

  const checklistFile = join(options.repoRoot, config.checklist);
  const contractDocFile = join(options.repoRoot, config.plan.contractDoc);
  const checklistDigest = sha256Hex(readFileSync(checklistFile, 'utf-8'));
  const planDigest = sha256Hex(existsSync(contractDocFile) ? readFileSync(contractDocFile, 'utf-8') : config.plan.title);

  // 6) 命令记录（来自步骤证据；argv/cwd 脱敏为逻辑位置）。
  const commands: P04CommandRecord[] = stepEvidence.records
    .filter((record) => record.status !== 'not_run')
    .map((record) => ({
      label: record.stepId,
      argv: record.argv.map((entry) => sanitize(entry)),
      cwd: toLogicalLocation(sanitize, record.cwd),
      exitCode: record.exitCode,
      durationMs: record.durationMs ?? 0,
      ...(record.timedOut ? { timedOut: true } : {}),
    }));

  // 7) 产品 Feature 执行报告引用（分层可追溯）。
  const productReports: { featureId: string; label: string; command: string; evidenceRef: string }[] = [];
  for (const product of options.productReports ?? []) {
    assertNonEmptyString(product.featureId, 'productReports.featureId');
    const ref = `evidence/product/${product.featureId}.json`;
    evidenceFiles.push({
      path: ref,
      category: 'report',
      checkId: null,
      content: product.content,
      capturedBeforeCleanup: true,
    });
    productReports.push({ featureId: product.featureId, label: product.label, command: product.command, evidenceRef: ref });
  }
  if (productReports.length === 0) {
    problems.push('缺少产品 Feature 执行报告引用：阶段报告与产品报告必须分层可追溯');
  }

  // 8) 运行级证据：状态、工具链、重放配方与 cleanup manifest。
  const generatedAtUtc = now().toISOString();
  evidenceFiles.push({
    path: 'evidence/state/git.json',
    category: 'git',
    checkId: null,
    content: `${JSON.stringify(
      {
        component: P04_INTEGRATION_REPORT_COMPONENT,
        commit: stepEvidence.identity.commit,
        headAtAggregation: headCommit,
        ...(gitHeadDrift ? { gitHeadDrift: true } : {}),
        branch,
        worktree,
        inputsDigest: stepEvidence.identity.inputsDigest,
      },
      null,
      2,
    )}\n`,
    capturedBeforeCleanup: true,
  });
  evidenceFiles.push({
    path: 'evidence/state/process.json',
    category: 'process',
    checkId: null,
    content: `${JSON.stringify(
      {
        component: P04_INTEGRATION_REPORT_COMPONENT,
        stopConfirmed: stepEvidence.stopConfirmed,
        processesGone,
        executedSteps: stepEvidence.records
          .filter((record) => record.status !== 'not_run')
          .map((record) => ({ stepId: record.stepId, endKind: record.endKind, exitCode: record.exitCode, stoppedVerified: record.stoppedVerified })),
      },
      null,
      2,
    )}\n`,
    capturedBeforeCleanup: true,
  });
  const serializedBindings = (options.bindings ?? []).map((binding) => ({
    checkId: binding.checkId,
    ...(binding.stepIds === undefined ? {} : { stepIds: [...binding.stepIds] }),
    ...(binding.scenarios === undefined
      ? {}
      : { scenarios: binding.scenarios.map((spec) => ({ file: spec.file, category: spec.category, ...(spec.scenarioIds === undefined ? {} : { scenarioIds: [...spec.scenarioIds] }) })) }),
    ...(binding.extraEvidence === undefined ? {} : { extraEvidence: binding.extraEvidence.map((extra) => ({ name: extra.name, category: extra.category })) }),
  }));
  evidenceFiles.push({
    path: 'evidence/state/inputs.json',
    category: 'artifact',
    checkId: null,
    content: `${JSON.stringify(
      {
        schemaVersion: P04_INTEGRATION_INPUTS_SCHEMA_VERSION,
        component: P04_INTEGRATION_REPORT_COMPONENT,
        runId,
        generatedAtUtc,
        stepRun: {
          dir: basename(options.stepRunDir),
          identity: stepEvidence.identity,
          manifestSha256: sha256Hex(readFileSync(join(options.stepRunDir, P04_STEP_RUN_MANIFEST_FILE), 'utf-8')),
        },
        planDigestSha256: planDigest,
        checklistDigestSha256: checklistDigest,
        scenarioFiles: [...scenarioFilesNeeded].sort().map((file) => {
          const loaded = scenarioByName.get(file) as LoadedScenario;
          return { file, ...(loaded.sha256 === null ? {} : { sha256: loaded.sha256, sizeBytes: loaded.sizeBytes }) };
        }),
        bindings: serializedBindings,
      },
      null,
      2,
    )}\n`,
    capturedBeforeCleanup: true,
  });
  evidenceFiles.push({
    path: 'evidence/toolchain/tool-versions.json',
    category: 'artifact',
    checkId: null,
    content: `${JSON.stringify(
      {
        component: P04_INTEGRATION_REPORT_COMPONENT,
        node: toolchain.node,
        npm: toolchain.npm,
        git: toolchain.git,
        sqlite: toolchain.sqlite,
        betterSqlite3: toolchain.betterSqlite3,
        drizzleOrm: toolchain.drizzleOrm,
        sdk: { package: toolchain.sdkPackage, version: toolchain.sdkVersion },
      },
      null,
      2,
    )}\n`,
    capturedBeforeCleanup: true,
  });
  const cleanupManifestRef = 'evidence/cleanup/manifest.json';
  evidenceFiles.push({
    path: cleanupManifestRef,
    category: 'manifest',
    checkId: null,
    content: `${JSON.stringify(
      {
        component: P04_INTEGRATION_REPORT_COMPONENT,
        runId,
        confirmed: cleanupConfirmed,
        processesGone,
        stepStopConfirmed: stepEvidence.stopConfirmed,
        notes: cleanupNotes,
        generatedAtUtc,
      },
      null,
      2,
    )}\n`,
    capturedBeforeCleanup: true,
  });

  // 9) 报告输入与写出（run-id 已存在即拒绝覆盖；写失败保留现场）。
  const openIssues: P04OpenIssue[] = [...(options.openIssues ?? [])];
  if (livePending.length > 0) {
    openIssues.push({ id: 'P04-PHASE-GATE-LIVE', summary: 'P04 阶段放行待真实 live 验收证据（当前 not_run，不被 mock 覆盖）', blocking: false });
  }
  if (manualPending.length > 0) {
    openIssues.push({ id: 'P04-PHASE-GATE-MANUAL', summary: 'P04 阶段放行待负责人人工确认（当前 pending，工具不代签）', blocking: false });
  }
  const knownLimitations = [
    'live 检查在本次汇总中保持 not_run：真实 Pi 闭环需显式授权与真实证据，不被 mock 结果覆盖。',
    '人工验收保持 pending：负责人身份/时间/结论由人工清单确认，模型不代签。',
    '本报告为阶段验收工具输出（phase-acceptance 层），工具交付通过不等于 P04 阶段验收通过。',
    `Pi SDK 版本记录于 evidence/toolchain/tool-versions.json（${P04_PI_SDK_PACKAGE}）。`,
    ...(options.knownLimitations ?? []),
  ];

  const reportRoot = resolve(options.reportRoot ?? join(options.repoRoot, config.reportRoot));
  const sensitiveValues = [
    options.repoRoot,
    options.stepRunDir,
    ...(scenarioRoot === null ? [] : [scenarioRoot]),
    homedir(),
    tmpdir(),
    ...(options.sensitiveValues ?? []),
  ];

  const pending = pendingFromChecklist(checklist, (checkId) => checkStatusById.get(checkId) ?? { status: 'not_run', manualPending: true });
  const coverage: P04IntegrationCoverage = {
    scenariosExpected,
    scenariosCovered,
    missingScenarioIds: [...missingScenarioIds],
    stepsPlanned: stepEvidence.plannedSteps.length,
    stepsVerified: stepEvidence.records.filter((record) => record.fromVerifiedEvidence && record.status !== 'not_run').length,
  };
  const offlineAllPass = requiredItems
    .filter((item) => item.execution === 'offline')
    .every((item) => checkStatusById.get(item.id)?.status === 'pass');

  const failResult = (extraProblems: readonly string[]): P04IntegrationReportResult => ({
    runId,
    exitCode: 1,
    reportWritten: false,
    written: null,
    verification: null,
    conclusion: null,
    toolDelivery: { status: 'fail', problemCount: toolProblems.length + extraProblems.length },
    phaseGate: { accepted: false, pending },
    coverage,
    problems: [...problems, ...extraProblems],
  });

  let written: P04WrittenReport;
  try {
    written = writeP04AcceptanceReport({
      reportRoot,
      checklist,
      sensitiveValues,
      evidenceFiles,
      input: {
        runId,
        generatedAtUtc,
        plan: {
          phaseId: config.plan.phaseId,
          stepId: config.plan.stepId,
          title: config.plan.title,
          scope: config.plan.scope,
          version: config.plan.version,
          contractDoc: config.plan.contractDoc,
          digestSha256: planDigest,
          checklistDigestSha256: checklistDigest,
        },
        git: {
          commit: stepEvidence.identity.commit,
          worktree,
          branch,
          priorBaselines: [{ phase: config.plan.phaseId, branch: branch ?? '<detached>', tipCommit: stepEvidence.identity.commit }],
        },
        platform: { system: platform(), release: release(), arch: arch() },
        tools: {
          node: toolchain.node,
          npm: toolchain.npm,
          git: toolchain.git,
          sqlite: toolchain.sqlite,
          betterSqlite3: toolchain.betterSqlite3,
          drizzleOrm: toolchain.drizzleOrm,
        },
        commands,
        results,
        cleanup: {
          confirmed: cleanupConfirmed,
          processesGone,
          manifestEvidenceRefs: [cleanupManifestRef],
          notes: cleanupNotes,
        },
        productReports,
        openIssues,
        knownLimitations,
        stateDigests: {
          ...(treeHash !== null && HEX_40.test(treeHash) ? { codeSha256: sha256Hex(treeHash) } : {}),
          businessInputSha256: sha256Hex(`${stepEvidence.identity.inputsDigest}\u0000${planDigest}\u0000${checklistDigest}`),
        },
      },
    });
  } catch (error) {
    if (error instanceof P04ReportError) {
      log(`${P04_INTEGRATION_REPORT_COMPONENT}: 报告写入失败（${error.kind}）：${error.message}`);
      return failResult([`报告写入失败（${error.kind}）：${error.message}`]);
    }
    return failResult([`报告写入失败：${error instanceof Error ? error.message : String(error)}`]);
  }

  problems.push(...written.verification.problems);
  toolProblems.push(...written.verification.problems);
  const toolDeliveryStatus: 'pass' | 'fail' = toolProblems.length === 0 && offlineAllPass ? 'pass' : 'fail';
  const exitCode =
    computeP04PhaseExitCode({
      conclusion: written.conclusion,
      evidenceOk: written.verification.ok,
      reportWritten: true,
      cleanupConfirmed: cleanupConfirmed && processesGone,
    }) === 0 && problems.length === 0
      ? 0
      : 1;
  log(`${P04_INTEGRATION_REPORT_COMPONENT}: ${exitCode === 0 ? 'PASS' : 'FAIL'} (toolDelivery=${toolDeliveryStatus} conclusion=${written.conclusion})`);
  return {
    runId,
    exitCode,
    reportWritten: true,
    written,
    verification: written.verification,
    conclusion: written.conclusion,
    toolDelivery: { status: toolDeliveryStatus, problemCount: toolProblems.length },
    phaseGate: { accepted: written.conclusion === 'pass', pending },
    coverage,
    problems,
  };
}
