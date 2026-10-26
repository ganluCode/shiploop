/**
 * P05-8 / F-003 阶段验收共用的有界顺序步骤执行与证据落盘组件。
 *
 * （开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口；
 * 对应 docs PRD `p05-acceptance.md` FR-2 与验收标准 1。）
 *
 * 职责：
 * - **顺序有界执行**：按声明顺序执行显式 argv/cwd 的子进程步骤，复用
 *   `runBoundedProcess`（独立进程组、有限单步超时、输出上限、超时后核验停止；
 *   不经 Shell 拼接、不后台化、不并发）。外层模型工具的 600 秒限制不是阶段
 *   总预算：总预算由本组件按 overallTimeoutMs 独立记账；
 * - **即时证据落盘**：每步启动即写入运行身份（runId/argv/cwd/超时）与日志位置
 *   的 `steps/<NN>-<id>.json`（status=running）和日志头；完成即改写为真实退出码、
 *   信号、耗时、超时与停止核验结果，并把 stdout/stderr（经 redact 钩子脱敏）写入
 *   `logs/<NN>-<id>.log`；每步完成即登记 sha256 水位到 `state.json`；
 * - **fail-closed**：入口缺失、参数/cwd 不符合预期、步骤超时、未知退出状态、
 *   证据写入失败（含写回校验失败）和停止不确定均使整体 exitCode 非零；
 * - **复用保护**：fresh 模式拒绝非空证据目录（不得覆盖）；resume 模式仅在
 *   runId、受测 commit、资源输入摘要与总预算完全一致且前缀步骤证据逐项核验
 *   通过时显式续跑；identity 不匹配、预算改变、证据损坏或前缀含失败步骤一律
 *   拒绝复用旧成功证据；已记录耗时计入总预算，重启/续跑不得清零或放大预算；
 * - **保留现场**：前序成功步骤的日志与证据在任何后续失败时原样保留（只追加
 *   state 水位、改写本运行自己的 running 记录，不删除任何已落盘文件）。
 *
 * 本组件不解析业务配置、不读凭据、不调用模型、不联网；仅写 evidenceDir 内的
 * 运行文件。仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型
 * 擦除直接运行。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { runBoundedProcess, type P02BoundedRunOutcome } from './p02-accept.ts';
import {
  P05_ACCEPT_MAX_OUTPUT_BYTES,
  P05_ACCEPT_MAX_TIMEOUT_MS,
  P05_ACCEPT_MIN_OUTPUT_BYTES,
  P05_ACCEPT_MIN_TIMEOUT_MS,
} from './p05-config.ts';

/* ------------------------------------------------------------------ *
 * 常量与错误
 * ------------------------------------------------------------------ */

export const P05_STEPS_SCHEMA_VERSION = 1;
export const P05_STEP_RUN_MANIFEST_FILE = 'run.json';
export const P05_STEP_STATE_FILE = 'state.json';
export const P05_STEP_EVIDENCE_SUBDIR = 'steps';
export const P05_STEP_LOG_SUBDIR = 'logs';

/** 步骤 ID 允许的字符（用于构造证据文件名，拒绝路径分隔与特殊字符）。 */
export const P05_STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const KNOWN_OUTCOME_KINDS: readonly P02BoundedRunOutcome['kind'][] = [
  'exit',
  'signal',
  'timeout',
  'spawn_error',
];

export type P05StepErrorKind =
  | 'invalid_step'
  | 'invalid_identity'
  | 'invalid_budget'
  | 'invalid_options'
  | 'evidence_dir_not_empty'
  | 'identity_mismatch'
  | 'budget_mismatch'
  | 'not_resumable'
  | 'evidence_corrupt'
  | 'evidence_write_failed';

export class P05StepError extends Error {
  readonly kind: P05StepErrorKind;
  readonly detail?: string;

  constructor(kind: P05StepErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'P05StepError';
    this.kind = kind;
    this.detail = detail;
  }
}

function fail(kind: P05StepErrorKind, message: string, detail?: string): never {
  throw new P05StepError(kind, message, detail);
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 运行身份：runId + 受测 commit + 资源输入摘要（复用证据的三要素）。 */
export interface P05StepIdentity {
  readonly runId: string;
  readonly commit: string;
  readonly inputsDigest: string;
}

/** 单个有界步骤：显式 argv 与 cwd，可选隔离环境与单步预算覆盖。 */
export interface P05StepSpec {
  readonly id: string;
  readonly label?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export type P05StepSequenceMode = 'fresh' | 'resume';

export interface P05StepSequenceOptions {
  /** 本次运行的证据目录（fresh：必须不存在或为空；resume：必须为既有运行目录）。 */
  readonly evidenceDir: string;
  readonly identity: P05StepIdentity;
  readonly mode?: P05StepSequenceMode;
  /** 默认单步预算（毫秒），被 step.timeoutMs 覆盖；总与剩余总预算取小。 */
  readonly stepTimeoutMs: number;
  /** 整套流程的总预算（毫秒）；跨 resume 续跑累计，不得放大。 */
  readonly overallTimeoutMs: number;
  readonly maxOutputBytes: number;
  /** 传给每个步骤的基线隔离环境（与 step.env 合并，步骤优先）。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 注入受控执行器（测试/控制器失败语义复用）；默认 runBoundedProcess。 */
  readonly runProcess?: typeof runBoundedProcess;
  /** 输出脱敏钩子：应用于写入日志与证据的 stdout/stderr 文本。 */
  readonly redact?: (text: string) => string;
  readonly log?: (message: string) => void;
  /** 可注入时钟（毫秒），用于预算记账；默认 Date.now。 */
  readonly now?: () => number;
}

export type P05StepStatus = 'pass' | 'fail' | 'not_run';
export type P05StepEndKind =
  | 'exit'
  | 'signal'
  | 'timeout'
  | 'spawn_error'
  | 'runner_error'
  | 'unknown'
  | 'not_started';
export type P05StepNotRunReason =
  | 'halted_by_prior_failure'
  | 'budget_exhausted'
  | 'evidence_write_failed';

export interface P05StepRecord {
  readonly index: number;
  readonly stepId: string;
  readonly label: string | null;
  readonly status: P05StepStatus;
  readonly notRunReason: P05StepNotRunReason | null;
  readonly endKind: P05StepEndKind;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number | null;
  readonly stoppedVerified: boolean | null;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly evidencePath: string;
  readonly logPath: string | null;
  /** resume 前缀：来自已核验的既有证据，本次未重新执行。 */
  readonly fromVerifiedEvidence: boolean;
}

export interface P05StepSequenceResult {
  /** 0 仅当全部步骤 pass、无问题、证据写回全部核验且停止全部确认。 */
  readonly exitCode: number;
  readonly runId: string;
  readonly evidenceDir: string;
  readonly mode: P05StepSequenceMode;
  readonly steps: readonly P05StepRecord[];
  readonly problems: readonly string[];
  readonly haltedStepId: string | null;
  readonly budgetExhausted: boolean;
  readonly stopConfirmed: boolean;
  readonly evidenceWritesVerified: boolean;
  /** resume 模式下从已核验证据续跑的步骤数（fresh 为 0）。 */
  readonly resumedFromCount: number;
}

interface P05StateEntry {
  readonly index: number;
  readonly stepId: string;
  readonly status: 'pass' | 'fail';
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  readonly logPath: string;
  readonly logSha256: string;
}

/* ------------------------------------------------------------------ *
 * 输入校验（任何子进程启动前完成）
 * ------------------------------------------------------------------ */

function assertBoundedBudget(value: unknown, min: number, max: number, label: string): number {
  if (!isBoundedInt(value, min, max)) {
    fail('invalid_budget', `${label} 必须是 ${min}..${max} 的有限毫秒预算：${String(value)}`);
  }
  return value;
}

/**
 * 校验步骤计划与选项。入口缺失（含分隔符的路径不存在）、参数含 NUL/非字符串、
 * cwd 非绝对/不存在、非法预算与身份在此即拒绝，不启动任何进程、不建证据目录。
 */
export function validateP05StepSequence(
  steps: readonly P05StepSpec[],
  options: P05StepSequenceOptions,
): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    fail('invalid_step', '步骤计划必须是非空数组');
  }
  if (!isPlainObject(options)) {
    fail('invalid_options', 'options 必须是对象');
  }
  if (typeof options.evidenceDir !== 'string' || options.evidenceDir.length === 0 || options.evidenceDir.includes('\0')) {
    fail('invalid_options', 'evidenceDir 必须是非空、不含 NUL 的路径');
  }
  if (options.mode !== undefined && options.mode !== 'fresh' && options.mode !== 'resume') {
    fail('invalid_options', `mode 只允许 fresh/resume：${String(options.mode)}`);
  }
  const identity = options.identity;
  if (!isPlainObject(identity)) {
    fail('invalid_identity', 'identity 必须是对象');
  }
  if (typeof identity.runId !== 'string' || !RUN_ID_PATTERN.test(identity.runId)) {
    fail('invalid_identity', `identity.runId 非法：${String(identity.runId)}`);
  }
  if (typeof identity.commit !== 'string' || !HEX_40.test(identity.commit)) {
    fail('invalid_identity', 'identity.commit 必须是 40 位小写十六进制（受测 Git commit）');
  }
  if (typeof identity.inputsDigest !== 'string' || !HEX_64.test(identity.inputsDigest)) {
    fail('invalid_identity', 'identity.inputsDigest 必须是 64 位小写十六进制（资源输入摘要）');
  }
  const stepTimeoutMs = assertBoundedBudget(options.stepTimeoutMs, P05_ACCEPT_MIN_TIMEOUT_MS, P05_ACCEPT_MAX_TIMEOUT_MS, 'stepTimeoutMs');
  const overallTimeoutMs = assertBoundedBudget(options.overallTimeoutMs, P05_ACCEPT_MIN_TIMEOUT_MS, P05_ACCEPT_MAX_TIMEOUT_MS, 'overallTimeoutMs');
  if (overallTimeoutMs < stepTimeoutMs) {
    fail('invalid_budget', `overallTimeoutMs 不得小于 stepTimeoutMs：${overallTimeoutMs} < ${stepTimeoutMs}`);
  }
  if (
    !isBoundedInt(options.maxOutputBytes, P05_ACCEPT_MIN_OUTPUT_BYTES, P05_ACCEPT_MAX_OUTPUT_BYTES)
  ) {
    fail('invalid_budget', `maxOutputBytes 必须是 ${P05_ACCEPT_MIN_OUTPUT_BYTES}..${P05_ACCEPT_MAX_OUTPUT_BYTES} 字节：${String(options.maxOutputBytes)}`);
  }
  if (options.env !== undefined && !isPlainObject(options.env)) {
    fail('invalid_options', 'env 必须是对象');
  }
  if (options.redact !== undefined && typeof options.redact !== 'function') {
    fail('invalid_options', 'redact 必须是函数');
  }
  if (options.log !== undefined && typeof options.log !== 'function') {
    fail('invalid_options', 'log 必须是函数');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    fail('invalid_options', 'now 必须是函数');
  }
  if (options.runProcess !== undefined && typeof options.runProcess !== 'function') {
    fail('invalid_options', 'runProcess 必须是函数');
  }
  const seenIds = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const at = `步骤 #${index + 1}`;
    if (!isPlainObject(step)) {
      fail('invalid_step', `${at} 必须是对象`);
    }
    if (typeof step.id !== 'string' || !P05_STEP_ID_PATTERN.test(step.id)) {
      fail('invalid_step', `${at} id 非法（须匹配 ${P05_STEP_ID_PATTERN.source}）：${String(step.id)}`);
    }
    if (seenIds.has(step.id)) {
      fail('invalid_step', `步骤 id 重复：${step.id}`);
    }
    seenIds.add(step.id);
    if (step.label !== undefined && typeof step.label !== 'string') {
      fail('invalid_step', `${at}（${step.id}）label 必须是字符串`);
    }
    if (typeof step.command !== 'string' || step.command.length === 0 || step.command.includes('\0')) {
      fail('invalid_step', `${at}（${step.id}）command 必须是非空、不含 NUL 的字符串`);
    }
    if (step.command.includes('/') && !existsSync(step.command)) {
      fail('invalid_step', `入口缺失：${step.command}（步骤 ${step.id}）`);
    }
    if (!Array.isArray(step.args)) {
      fail('invalid_step', `${at}（${step.id}）args 必须是字符串数组`);
    }
    for (const arg of step.args) {
      if (typeof arg !== 'string' || arg.includes('\0')) {
        fail('invalid_step', `步骤 ${step.id} 的参数必须是不含 NUL 的字符串：${String(arg)}`);
      }
    }
    if (typeof step.cwd !== 'string' || !isAbsolute(step.cwd) || step.cwd.includes('\0')) {
      fail('invalid_step', `步骤 ${step.id} 的 cwd 必须是绝对路径：${String(step.cwd)}`);
    }
    if (!existsSync(step.cwd) || !statSync(step.cwd).isDirectory()) {
      fail('invalid_step', `步骤 ${step.id} 的 cwd 不存在或不是目录：${step.cwd}`);
    }
    if (step.env !== undefined && !isPlainObject(step.env)) {
      fail('invalid_step', `步骤 ${step.id} 的 env 必须是对象`);
    }
    if (step.timeoutMs !== undefined) {
      const timeoutMs = assertBoundedBudget(step.timeoutMs, P05_ACCEPT_MIN_TIMEOUT_MS, P05_ACCEPT_MAX_TIMEOUT_MS, `步骤 ${step.id} timeoutMs`);
      if (timeoutMs > overallTimeoutMs) {
        fail('invalid_budget', `步骤 ${step.id} timeoutMs 超过总预算：${timeoutMs} > ${overallTimeoutMs}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 证据写入（写回核验）
 * ------------------------------------------------------------------ */

/** 写入后立即读回比对；不一致按证据写入失败处理（fail-closed）。 */
function writeVerifiedFile(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  if (readFileSync(filePath, 'utf8') !== content) {
    throw new P05StepError('evidence_write_failed', `证据写回校验失败：${filePath}`);
  }
}

function stepFileStem(index: number, stepId: string): string {
  return `${String(index + 1).padStart(2, '0')}-${stepId}`;
}

function stepEvidenceRelPath(index: number, stepId: string): string {
  return `${P05_STEP_EVIDENCE_SUBDIR}/${stepFileStem(index, stepId)}.json`;
}

function stepLogRelPath(index: number, stepId: string): string {
  return `${P05_STEP_LOG_SUBDIR}/${stepFileStem(index, stepId)}.log`;
}

interface StepStartEvidence {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly index: number;
  readonly stepId: string;
  readonly label: string | null;
  readonly status: 'running';
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly startedAtUtc: string;
  readonly evidencePath: string;
  readonly logPath: string;
}

function logHeader(start: StepStartEvidence): string {
  return [
    `# run ${start.runId} step ${start.index + 1} ${start.stepId}`,
    `# label ${start.label ?? '-'}`,
    `# started ${start.startedAtUtc}`,
    `# argv ${JSON.stringify(start.argv)}`,
    `# cwd ${start.cwd}`,
    `# timeoutMs ${start.timeoutMs}`,
  ].join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * 运行清单（run.json）与水位（state.json）
 * ------------------------------------------------------------------ */

interface RunManifest {
  readonly schemaVersion: number;
  readonly component: 'p05-steps';
  readonly identity: P05StepIdentity;
  readonly budget: {
    readonly stepTimeoutMs: number;
    readonly overallTimeoutMs: number;
    readonly maxOutputBytes: number;
    readonly previouslyConsumedMs: number;
  };
  readonly plannedSteps: readonly { readonly index: number; readonly id: string }[];
  readonly openedAtUtc: string;
}

function manifestJson(manifest: RunManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

function stateJson(runId: string, entries: readonly P05StateEntry[]): string {
  return JSON.stringify({ schemaVersion: P05_STEPS_SCHEMA_VERSION, runId, entries }, null, 2) + '\n';
}

/* ------------------------------------------------------------------ *
 * 主入口：有界顺序步骤执行
 * ------------------------------------------------------------------ */

/**
 * 执行一组有界步骤并把证据落盘到 evidenceDir。
 *
 * 失败语义（均以非零 exitCode 或 P05StepError 结束）：入口缺失/参数/cwd/预算/
 * 身份非法在启动前抛出；步骤超时、非零退出、信号退出、未知退出状态、执行器
 * 异常、停止不确定、证据写入失败使整体结果非零，但保留全部已落盘证据。
 */
export async function runP05StepSequence(
  steps: readonly P05StepSpec[],
  options: P05StepSequenceOptions,
): Promise<P05StepSequenceResult> {
  validateP05StepSequence(steps, options);
  const mode: P05StepSequenceMode = options.mode ?? 'fresh';
  const now = options.now ?? Date.now;
  const redact = options.redact ?? ((text: string) => text);
  const log = options.log ?? (() => undefined);
  const evidenceDir = options.evidenceDir;
  const stepsDir = join(evidenceDir, P05_STEP_EVIDENCE_SUBDIR);
  const logsDir = join(evidenceDir, P05_STEP_LOG_SUBDIR);
  const manifestPath = join(evidenceDir, P05_STEP_RUN_MANIFEST_FILE);
  const statePath = join(evidenceDir, P05_STEP_STATE_FILE);
  const problems: string[] = [];
  const records: P05StepRecord[] = [];
  const stateEntries: P05StateEntry[] = [];
  let prefixLength = 0;
  let consumedMs = 0;
  let evidenceWritesVerified = true;

  /* ---------- 打开证据目录：fresh 拒绝非空；resume 核验身份与证据 ---------- */

  if (mode === 'fresh') {
    if (existsSync(evidenceDir)) {
      if (!statSync(evidenceDir).isDirectory()) {
        fail('evidence_dir_not_empty', `证据目录路径不是目录：${evidenceDir}`);
      }
      const existing = readdirSync(evidenceDir);
      if (existing.length > 0) {
        fail(
          'evidence_dir_not_empty',
          `证据目录非空，拒绝覆盖既有内容：${evidenceDir}（${existing.length} 项）`,
        );
      }
    } else {
      mkdirSync(evidenceDir, { recursive: true });
    }
  } else {
    if (!existsSync(manifestPath)) {
      fail('not_resumable', `resume 需要已存在的 ${P05_STEP_RUN_MANIFEST_FILE}：${evidenceDir}`);
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      fail('evidence_corrupt', `${P05_STEP_RUN_MANIFEST_FILE} 无法解析：${errorMessage(error)}`);
    }
    if (!isPlainObject(manifest) || manifest.schemaVersion !== P05_STEPS_SCHEMA_VERSION || !isPlainObject(manifest.identity)) {
      fail('evidence_corrupt', `${P05_STEP_RUN_MANIFEST_FILE} 结构或 schemaVersion 不符`);
    }
    const recorded = manifest.identity as Record<string, unknown>;
    for (const field of ['runId', 'commit', 'inputsDigest'] as const) {
      if (recorded[field] !== options.identity[field]) {
        fail(
          'identity_mismatch',
          `拒绝复用旧成功证据：identity.${field} 不匹配（受测 commit 或资源输入已变化）`,
          `recorded=${String(recorded[field])} requested=${String(options.identity[field])}`,
        );
      }
    }
    if (!isPlainObject(manifest.budget)) {
      fail('evidence_corrupt', `${P05_STEP_RUN_MANIFEST_FILE} 缺少 budget`);
    }
    if (
      manifest.budget.overallTimeoutMs !== options.overallTimeoutMs ||
      manifest.budget.stepTimeoutMs !== options.stepTimeoutMs
    ) {
      fail(
        'budget_mismatch',
        '拒绝续跑：stepTimeoutMs/overallTimeoutMs 与原运行不一致（重启不得清零或放大总预算）',
        `recorded overall=${String(manifest.budget.overallTimeoutMs)} step=${String(manifest.budget.stepTimeoutMs)}`,
      );
    }
    if (!Array.isArray(manifest.plannedSteps) || manifest.plannedSteps.length !== steps.length) {
      fail('not_resumable', 'resume 计划与原运行的 plannedSteps 不一致');
    }
    for (const [index, planned] of manifest.plannedSteps.entries()) {
      const step = steps[index];
      if (!isPlainObject(planned) || planned.id !== step?.id) {
        fail('not_resumable', `resume 计划第 ${index + 1} 步与原运行不一致`);
      }
    }
    if (!existsSync(statePath)) {
      fail('not_resumable', `resume 需要已存在的 ${P05_STEP_STATE_FILE}`);
    }
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (error) {
      fail('evidence_corrupt', `${P05_STEP_STATE_FILE} 无法解析：${errorMessage(error)}`);
    }
    const entries = isPlainObject(state) ? state.entries : undefined;
    if (!Array.isArray(entries)) {
      fail('evidence_corrupt', `${P05_STEP_STATE_FILE} 缺少 entries`);
    }
    if (entries.length > steps.length) {
      fail('not_resumable', `state 记录了 ${entries.length} 步，多于当前计划的 ${steps.length} 步`);
    }
    for (const [index, rawEntry] of entries.entries()) {
      const step = steps[index];
      if (!isPlainObject(rawEntry) || rawEntry.stepId !== step?.id || typeof index !== 'number') {
        fail('evidence_corrupt', `state entry #${index} 与计划或结构不符`);
      }
      const status = rawEntry.status;
      if (status !== 'pass' && status !== 'fail') {
        fail('evidence_corrupt', `state entry #${index} 状态非法：${String(status)}`);
      }
      const evidenceRel =
        typeof rawEntry.evidencePath === 'string' ? rawEntry.evidencePath : stepEvidenceRelPath(index, step.id);
      const logRel = typeof rawEntry.logPath === 'string' ? rawEntry.logPath : stepLogRelPath(index, step.id);
      const evidenceAbs = join(evidenceDir, evidenceRel);
      if (!existsSync(evidenceAbs)) {
        fail('evidence_corrupt', `步骤证据缺失：${evidenceRel}`);
      }
      const content = readFileSync(evidenceAbs, 'utf8');
      if (sha256Hex(content) !== rawEntry.evidenceSha256) {
        fail('evidence_corrupt', `步骤证据哈希与水位不符：${evidenceRel}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        fail('evidence_corrupt', `步骤证据无法解析：${evidenceRel}：${errorMessage(error)}`);
      }
      if (!isPlainObject(parsed) || parsed.status !== status || parsed.stepId !== step.id) {
        fail('evidence_corrupt', `步骤证据与水位记录不一致：${evidenceRel}`);
      }
      if (status !== 'pass') {
        fail(
          'not_resumable',
          `前缀含未通过步骤 ${String(rawEntry.stepId)}（status=${status}）：显式续跑不得复用失败现场，请在新证据目录完整重跑`,
        );
      }
      const logAbs = join(evidenceDir, logRel);
      if (!existsSync(logAbs)) {
        fail('evidence_corrupt', `步骤日志缺失：${logRel}`);
      }
      if (sha256Hex(readFileSync(logAbs, 'utf8')) !== rawEntry.logSha256) {
        fail('evidence_corrupt', `步骤日志哈希与水位不符：${logRel}`);
      }
      if (typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs)) {
        consumedMs += parsed.durationMs;
      }
      stateEntries.push({
        index,
        stepId: step.id,
        status,
        evidencePath: evidenceRel,
        evidenceSha256: sha256Hex(content),
        logPath: logRel,
        logSha256: rawEntry.logSha256 as string,
      });
      records.push(recordFromVerifiedEvidence(index, parsed));
      prefixLength = index + 1;
    }
  }

  mkdirSync(stepsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  if (mode === 'fresh') {
    const manifest: RunManifest = {
      schemaVersion: P05_STEPS_SCHEMA_VERSION,
      component: 'p05-steps',
      identity: options.identity,
      budget: {
        stepTimeoutMs: options.stepTimeoutMs,
        overallTimeoutMs: options.overallTimeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        previouslyConsumedMs: 0,
      },
      plannedSteps: steps.map((step, index) => ({ index, id: step.id })),
      openedAtUtc: isoFromMs(now()),
    };
    try {
      writeVerifiedFile(manifestPath, manifestJson(manifest));
    } catch (error) {
      fail('evidence_write_failed', `无法写入 ${P05_STEP_RUN_MANIFEST_FILE}：${errorMessage(error)}`);
    }
  }

  /* ---------------------------- 顺序执行 ---------------------------- */

  // 基准起点回退已核验的既往耗时：续跑不清零总预算。
  const budgetStartRef = now() - consumedMs;
  type Halt = 'prior_failure' | 'budget' | 'evidence_write' | null;
  let halt: Halt = null;
  let haltedStepId: string | null = null;
  let budgetExhausted = false;
  let stopConfirmed = true;

  const notRunReasonFor = (reason: Halt): P05StepNotRunReason => {
    if (reason === 'budget') return 'budget_exhausted';
    if (reason === 'evidence_write') return 'evidence_write_failed';
    return 'halted_by_prior_failure';
  };

  const pushNotRunRecord = (step: P05StepSpec, index: number, reason: P05StepNotRunReason): void => {
    const evidenceRel = stepEvidenceRelPath(index, step.id);
    const notRunJson =
      JSON.stringify(
        {
          schemaVersion: P05_STEPS_SCHEMA_VERSION,
          runId: options.identity.runId,
          index,
          stepId: step.id,
          label: step.label ?? null,
          status: 'not_run',
          notRunReason: reason,
          endKind: 'not_started',
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: null,
          stoppedVerified: null,
          argv: [step.command, ...step.args],
          cwd: step.cwd,
          startedAtUtc: null,
          completedAtUtc: null,
          evidencePath: evidenceRel,
          logPath: null,
        },
        null,
        2,
      ) + '\n';
    try {
      writeVerifiedFile(join(evidenceDir, evidenceRel), notRunJson);
    } catch (error) {
      problems.push(`not_run 记录写入失败（${step.id}）：${errorMessage(error)}`);
      evidenceWritesVerified = false;
    }
    records.push({
      index,
      stepId: step.id,
      label: step.label ?? null,
      status: 'not_run',
      notRunReason: reason,
      endKind: 'not_started',
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: null,
      stoppedVerified: null,
      argv: [step.command, ...step.args],
      cwd: step.cwd,
      evidencePath: evidenceRel,
      logPath: null,
      fromVerifiedEvidence: false,
    });
  };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (index < prefixLength) {
      continue; // 已由核验过的证据覆盖，不重新执行、不覆盖旧证据。
    }
    if (halt !== null) {
      pushNotRunRecord(step, index, notRunReasonFor(halt));
      continue;
    }
    const remainingMs = options.overallTimeoutMs - (now() - budgetStartRef);
    if (remainingMs <= 0) {
      halt = 'budget';
      budgetExhausted = true;
      haltedStepId = step.id;
      problems.push(`阶段总时间预算耗尽，步骤 ${step.id} 未启动`);
      pushNotRunRecord(step, index, 'budget_exhausted');
      continue;
    }
    const timeoutMs = Math.min(step.timeoutMs ?? options.stepTimeoutMs, remainingMs);
    const startedAtMs = now();
    const start: StepStartEvidence = {
      schemaVersion: P05_STEPS_SCHEMA_VERSION,
      runId: options.identity.runId,
      index,
      stepId: step.id,
      label: step.label ?? null,
      status: 'running',
      argv: [step.command, ...step.args],
      cwd: step.cwd,
      timeoutMs,
      startedAtUtc: isoFromMs(startedAtMs),
      evidencePath: stepEvidenceRelPath(index, step.id),
      logPath: stepLogRelPath(index, step.id),
    };
    const header = logHeader(start);
    try {
      // 启动即落盘：运行身份 + 日志位置（status=running）。
      writeVerifiedFile(join(evidenceDir, start.evidencePath), JSON.stringify(start, null, 2) + '\n');
      writeVerifiedFile(join(evidenceDir, start.logPath), header);
    } catch (error) {
      problems.push(`证据写入失败（步骤 ${step.id} 启动记录）：${errorMessage(error)}`);
      evidenceWritesVerified = false;
      halt = 'evidence_write';
      haltedStepId = step.id;
      records.push({
        index,
        stepId: step.id,
        label: step.label ?? null,
        status: 'fail',
        notRunReason: null,
        endKind: 'not_started',
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: null,
        stoppedVerified: null,
        argv: start.argv,
        cwd: step.cwd,
        evidencePath: start.evidencePath,
        logPath: null,
        fromVerifiedEvidence: false,
      });
      continue;
    }
    log(`p05-steps: RUN ${index + 1}/${steps.length} ${step.id} (${step.command})`);

    const mergedEnv =
      step.env === undefined && options.env === undefined
        ? undefined
        : { ...(options.env ?? {}), ...(step.env ?? {}) };

    let outcome: P02BoundedRunOutcome | null = null;
    let runnerError: string | null = null;
    const runner = options.runProcess ?? runBoundedProcess;
    try {
      outcome = await runner(step.command, step.args, {
        cwd: step.cwd,
        ...(mergedEnv === undefined ? {} : { env: mergedEnv }),
        timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
    } catch (error) {
      runnerError = errorMessage(error);
    }

    const completedAtMs = now();
    let endKind: P05StepEndKind;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let timedOut = false;
    let durationMs: number;
    let stoppedVerified: boolean;
    let spawnError: string | null = null;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    if (runnerError !== null) {
      // 执行器异常：没有停止证据，按停止不确定处理。
      endKind = 'runner_error';
      durationMs = completedAtMs - startedAtMs;
      stoppedVerified = false;
      problems.push(`步骤执行器异常（${step.id}）：${runnerError}`);
    } else if (outcome === null) {
      endKind = 'unknown';
      durationMs = completedAtMs - startedAtMs;
      stoppedVerified = false;
      problems.push(`步骤执行器未返回结果（${step.id}）`);
    } else {
      endKind = outcome.kind;
      exitCode = outcome.exitCode;
      signal = outcome.signal;
      timedOut = outcome.timedOut;
      durationMs = outcome.durationMs;
      stoppedVerified = outcome.stoppedVerified;
      spawnError = outcome.spawnError;
      stdout = redact(outcome.stdout);
      stderr = redact(outcome.stderr);
      stdoutBytes = outcome.stdoutBytes;
      stderrBytes = outcome.stderrBytes;
      stdoutTruncated = outcome.stdoutTruncated;
      stderrTruncated = outcome.stderrTruncated;
      if (!(KNOWN_OUTCOME_KINDS as readonly string[]).includes(outcome.kind)) {
        endKind = 'unknown';
        problems.push(`未知退出状态 kind=${String(outcome.kind)}（步骤 ${step.id}）`);
      } else if (outcome.kind === 'exit' && typeof outcome.exitCode !== 'number') {
        endKind = 'unknown';
        problems.push(`未知退出状态：exit 无退出码（步骤 ${step.id}），不伪造 0/1`);
      } else if (outcome.kind === 'signal' && typeof outcome.signal !== 'string') {
        endKind = 'unknown';
        problems.push(`未知退出状态：signal 退出缺少信号名（步骤 ${step.id}）`);
      }
    }

    const passed =
      endKind === 'exit' && exitCode === 0 && !timedOut && stoppedVerified === true;
    const status: P05StepStatus = passed ? 'pass' : 'fail';
    if (stoppedVerified !== true) {
      stopConfirmed = false;
    }
    if (timedOut) {
      problems.push(`步骤 ${step.id} 超过有限超时 ${timeoutMs}ms`);
    } else if (!passed && endKind !== 'runner_error' && endKind !== 'unknown') {
      problems.push(
        `步骤 ${step.id} 失败：kind=${endKind} exitCode=${exitCode === null ? 'null' : String(exitCode)} signal=${signal ?? 'null'}`,
      );
    }

    const completionRecord = {
      ...start,
      status,
      endKind,
      exitCode,
      signal,
      timedOut,
      durationMs,
      stoppedVerified,
      spawnError,
      stdoutBytes,
      stderrBytes,
      stdoutTruncated,
      stderrTruncated,
      completedAtUtc: isoFromMs(completedAtMs),
    };
    const completionJson = JSON.stringify(completionRecord, null, 2) + '\n';
    const logContent =
      header +
      `--- stdout (${stdoutBytes} bytes, truncated=${stdoutTruncated}) ---\n${stdout}` +
      (stdout.endsWith('\n') || stdout === '' ? '' : '\n') +
      `--- stderr (${stderrBytes} bytes, truncated=${stderrTruncated}) ---\n${stderr}` +
      (stderr.endsWith('\n') || stderr === '' ? '' : '\n') +
      `--- end kind=${endKind} exitCode=${exitCode === null ? 'null' : String(exitCode)} signal=${signal ?? 'null'} timedOut=${timedOut} stoppedVerified=${stoppedVerified} durationMs=${durationMs} ---\n`;

    try {
      writeVerifiedFile(join(evidenceDir, start.evidencePath), completionJson);
      writeVerifiedFile(join(evidenceDir, start.logPath), logContent);
      stateEntries.push({
        index,
        stepId: step.id,
        status,
        evidencePath: start.evidencePath,
        evidenceSha256: sha256Hex(completionJson),
        logPath: start.logPath,
        logSha256: sha256Hex(logContent),
      });
      writeVerifiedFile(statePath, stateJson(options.identity.runId, stateEntries));
    } catch (error) {
      // 完成证据写不进：保留已写入内容，整体 fail-closed，后续步骤不再启动。
      problems.push(`证据写入失败（步骤 ${step.id} 完成记录）：${errorMessage(error)}`);
      evidenceWritesVerified = false;
      halt = 'evidence_write';
      haltedStepId = step.id;
      records.push({
        index,
        stepId: step.id,
        label: step.label ?? null,
        status: 'fail',
        notRunReason: null,
        endKind,
        exitCode,
        signal,
        timedOut,
        durationMs,
        stoppedVerified,
        argv: start.argv,
        cwd: step.cwd,
        evidencePath: start.evidencePath,
        logPath: start.logPath,
        fromVerifiedEvidence: false,
      });
      continue;
    }
    records.push({
      index,
      stepId: step.id,
      label: step.label ?? null,
      status,
      notRunReason: null,
      endKind,
      exitCode,
      signal,
      timedOut,
      durationMs,
      stoppedVerified,
      argv: start.argv,
      cwd: step.cwd,
      evidencePath: start.evidencePath,
      logPath: start.logPath,
      fromVerifiedEvidence: false,
    });
    if (!passed) {
      halt = 'prior_failure';
      haltedStepId = step.id;
    }
  }

  /* --------------------------- 汇总与收尾 --------------------------- */

  const passCount = records.filter((record) => record.status === 'pass').length;
  const failCount = records.filter((record) => record.status === 'fail').length;
  const notRunCount = records.filter((record) => record.status === 'not_run').length;
  const conclusion = records.length === steps.length && failCount === 0 && notRunCount === 0 ? 'pass' : 'fail';
  try {
    const baseManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeVerifiedFile(
      manifestPath,
      JSON.stringify(
        {
          ...baseManifest,
          summary: {
            conclusion,
            counts: { pass: passCount, fail: failCount, not_run: notRunCount },
            haltedStepId,
            budgetExhausted,
            stopConfirmed,
            resumedFromCount: prefixLength,
            finishedAtUtc: isoFromMs(now()),
          },
        },
        null,
        2,
      ) + '\n',
    );
  } catch (error) {
    problems.push(`运行清单汇总写入失败：${errorMessage(error)}`);
    evidenceWritesVerified = false;
  }

  const allPassed = conclusion === 'pass';
  const exitCode =
    allPassed && problems.length === 0 && evidenceWritesVerified && stopConfirmed && halt === null
      ? 0
      : 1;
  log(`p05-steps: ${exitCode === 0 ? 'PASS' : 'FAIL'} (pass=${passCount} fail=${failCount} not_run=${notRunCount})`);
  return {
    exitCode,
    runId: options.identity.runId,
    evidenceDir,
    mode,
    steps: records,
    problems,
    haltedStepId,
    budgetExhausted,
    stopConfirmed,
    evidenceWritesVerified,
    resumedFromCount: prefixLength,
  };
}

function recordFromVerifiedEvidence(index: number, parsed: Record<string, unknown>): P05StepRecord {
  return {
    index,
    stepId: typeof parsed.stepId === 'string' ? parsed.stepId : `#${index + 1}`,
    label: typeof parsed.label === 'string' ? parsed.label : null,
    status: 'pass',
    notRunReason: null,
    endKind: typeof parsed.endKind === 'string' ? (parsed.endKind as P05StepEndKind) : 'exit',
    exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
    signal: typeof parsed.signal === 'string' ? parsed.signal : null,
    timedOut: parsed.timedOut === true,
    durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : null,
    stoppedVerified: parsed.stoppedVerified === true,
    argv: Array.isArray(parsed.argv) ? (parsed.argv as string[]) : [],
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
    evidencePath: typeof parsed.evidencePath === 'string' ? parsed.evidencePath : '',
    logPath: typeof parsed.logPath === 'string' ? parsed.logPath : null,
    fromVerifiedEvidence: true,
  };
}
