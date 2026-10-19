/**
 * P03-10 / F-016 P03 阶段验收报告聚合、证据索引、脱敏与严格退出结论
 * （开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口）。
 *
 * 复用 P01/P02 已建立的验收报告机制（scripts/acceptance/p01-report.ts、
 * p02-report.ts），按 `acceptance/p03.checklist.json` 与
 * `acceptance/p03.config.json`（F-002 冻结契约）实现 P03 专属的报告层：
 *
 * - **分层**：阶段报告（reportLayer=`phase-acceptance`，本模块）与产品 Feature
 *   执行报告（`feature-execution-report`，Core/Host/CLI 投影）明确分层。阶段报告
 *   只引用完整产品报告的不可变证据（路径/hash/size），不把产品报告直接拼接成
 *   阶段结论，也不反写产品状态；
 * - **清单驱动**：必需检查 ID、顺序、验证层次（unit / feature-integration /
 *   phase-acceptance）、FR 映射、T 编号映射、清单断言文本与证据类别均来自
 *   P03 检查清单；未知/重复检查 ID 直接拒绝，缺失必需项记 not_run，不静默聚合；
 * - **严格三态**：pass / fail / not_run；not_run 必须分类为 missing_result /
 *   preparation_failure / missing_output / timeout / skipped。正常与预期负例的
 *   pass 都要求：至少一条真实状态断言且全部满足、副作用核对通过、执行身份为
 *   Fake（配置冻结 realModel=false / network=denied）。缺断言、断言不满足、
 *   副作用未核对、使用 live 执行（真假执行混淆）都降级 fail；只有 detail /
 *   logger 文本不构成通过依据；
 * - **清理与证据**：SQLite/Git/进程与 cleanup manifest 必须在临时资源清理前导出
 *   （证据条目 capturedBeforeCleanup=true）；每项必需检查声明的证据类别须由其
 *   证据引用覆盖。证据为报告目录内相对路径（evidence/ 前缀），记录稳定身份
 *   identity、类别、hash、size；重复身份/重复路径拒绝。cleanup 未确认、受管
 *   进程组未确认消失、缺 manifest 证据或阻塞遗留问题均使结论非零；
 * - **run-id 与重验**：每次运行独立 <reportRoot>/<run-id>/（report.json /
 *   summary.md / evidence/…），已存在 run-id 拒绝覆盖；写出后立即重读整目录，
 *   报告 Schema、计数、结论、证据 size/sha256 任一不符即非零；
 * - **脱敏**：合成凭据、Bearer 形状、凭据键名与开发机绝对路径（/Users/…、
 *   /home/…、C:\Users\…）不得进入 report.json、summary.md 或证据；脱敏后按实际
 *   落盘字节计算证据 hash，验证时与文件一致。扫描/脱敏失败以明确错误可见，
 *   不静默放行；
 * - **遗留问题**：openIssues 保留 blocking 标记，非阻塞项可见但不改变结论，
 *   阻塞项使阶段结论非零；deferred 检查项只显示 not_run/postponed，不计入
 *   pass 数（deferredCountsAsPassed=false）。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接
 * 运行；不调用模型、不联网，只写 reportRoot 下的运行目录。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  P03_EVIDENCE_CATEGORIES,
  P03_FAKE_IDENTITY,
  P03_REQUIRED_CHECK_IDS,
  loadP03Checklist,
} from './p03-config.ts';
import type {
  P03Checklist,
  P03ChecklistItem,
  P03DeferredStatus,
  P03EvidenceCategory,
  P03Layer,
} from './p03-config.ts';

/* ------------------------------------------------------------------ *
 * 常量与错误
 * ------------------------------------------------------------------ */

export const P03_ACCEPTANCE_REPORT_SCHEMA_VERSION = 1;
export const P03_REPORT_FILE_NAME = 'report.json';
export const P03_SUMMARY_FILE_NAME = 'summary.md';
export const P03_EVIDENCE_DIR_NAME = 'evidence';
export const P03_REPORT_LAYER = 'phase-acceptance';
export const P03_PRODUCT_REPORT_LAYER = 'feature-execution-report';

/** 清理前必须导出的阶段证据类别（SQLite/Git/进程 + cleanup manifest）。 */
export const P03_PHASE_EVIDENCE_CATEGORIES = ['sqlite', 'git', 'process', 'manifest'] as const;
export type P03PhaseEvidenceCategory = (typeof P03_PHASE_EVIDENCE_CATEGORIES)[number];

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUN_ID_MAX_LENGTH = 128;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const LOGICAL_LOCATION_PATTERN = /^<[A-Za-z0-9][A-Za-z0-9._-]*>(\/[A-Za-z0-9._-]+)*$/;

export type P03ReportErrorKind =
  | 'invalid_input'
  | 'invalid_run_id'
  | 'run_id_exists'
  | 'unknown_check'
  | 'duplicate_check'
  | 'duplicate_evidence'
  | 'invalid_result'
  | 'invalid_report'
  | 'evidence_missing'
  | 'evidence_corrupt'
  | 'unsafe_path'
  | 'secret_leak'
  | 'absolute_path_leak'
  | 'report_write_failed';

export class P03ReportError extends Error {
  readonly kind: P03ReportErrorKind;
  readonly detail?: string;

  constructor(kind: P03ReportErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'P03ReportError';
    this.kind = kind;
    this.detail = detail;
  }
}

function fail(kind: P03ReportErrorKind, message: string, detail?: string): never {
  throw new P03ReportError(kind, message, detail);
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
 * 路径安全
 * ------------------------------------------------------------------ */

/** 校验报告内相对路径（POSIX 分隔、无越界段），返回规范化路径。 */
export function assertSafeReportRelativePath(relativePath: unknown, label: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    fail('unsafe_path', `${label} 必须是非空字符串`);
  }
  const path = relativePath as string;
  if (path.includes('\0') || path.startsWith('/') || path.includes('\\')) {
    fail('unsafe_path', `${label} 必须为 POSIX 相对路径：${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('unsafe_path', `${label} 不允许空段/./..：${path}`);
  }
  return segments.join('/');
}

/** 证据路径必须位于报告目录内 evidence/ 下。 */
export function assertEvidenceReportPath(relativePath: unknown, label: string): string {
  const normalized = assertSafeReportRelativePath(relativePath, label);
  const segments = normalized.split('/');
  if (segments[0] !== P03_EVIDENCE_DIR_NAME || segments.length < 2) {
    fail('unsafe_path', `${label} 必须位于 ${P03_EVIDENCE_DIR_NAME}/ 之内：${normalized}`);
  }
  return normalized;
}

/** 逻辑位置（如 <repo>、<repo>/packages/core）：拒绝绝对路径与个人目录。 */
export function assertLogicalLocation(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOGICAL_LOCATION_PATTERN.test(value)) {
    fail(
      'invalid_input',
      `${label} 必须是逻辑位置（如 <repo> 或 <repo>/relative/path），收到：${String(value)}`,
    );
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * run-id
 * ------------------------------------------------------------------ */

export function assertValidRunId(runId: unknown): string {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > RUN_ID_MAX_LENGTH) {
    fail('invalid_run_id', `run-id 必须是 1~${RUN_ID_MAX_LENGTH} 字符的字符串`);
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    fail('invalid_run_id', `run-id 非法（须匹配 ${RUN_ID_PATTERN.source}）：${runId}`);
  }
  return runId;
}

/** 由 UTC 时钟与随机后缀派生 run-id：<YYYYMMDDThhmmssZ>-<8 hex>。 */
export function generateP03RunId(nowUtc: Date, randomSuffixHex?: string): string {
  if (!(nowUtc instanceof Date) || Number.isNaN(nowUtc.getTime())) {
    fail('invalid_run_id', '生成 run-id 需要有效的 Date');
  }
  const suffix = randomSuffixHex ?? randomBytes(4).toString('hex');
  if (!/^[0-9a-f]{8}$/.test(suffix)) {
    fail('invalid_run_id', `run-id 随机后缀必须是 8 位小写十六进制：${suffix}`);
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${nowUtc.getUTCFullYear()}${pad(nowUtc.getUTCMonth() + 1)}${pad(nowUtc.getUTCDate())}` +
    `T${pad(nowUtc.getUTCHours())}${pad(nowUtc.getUTCMinutes())}${pad(nowUtc.getUTCSeconds())}Z`;
  return assertValidRunId(`${stamp}-${suffix}`);
}

/* ------------------------------------------------------------------ *
 * 脱敏与扫描
 * ------------------------------------------------------------------ */

function normalizeSensitiveValues(
  sensitiveValues: readonly string[] | undefined,
): readonly string[] {
  if (sensitiveValues === undefined) {
    return [];
  }
  if (!Array.isArray(sensitiveValues)) {
    fail('invalid_input', 'sensitiveValues 必须是字符串数组');
  }
  const seen = new Set<string>();
  for (const value of sensitiveValues) {
    if (typeof value !== 'string' || value.length === 0) {
      fail('invalid_input', 'sensitiveValues 只允许非空字符串（空值会破坏脱敏替换）');
    }
    seen.add(value);
  }
  // 长值优先替换，避免短值先替换后长值永远无法命中。
  return [...seen].sort((a, b) => b.length - a.length);
}

/** 文本脱敏：敏感值的所有出现替换为带内容摘要的占位符（不回显秘密本身）。 */
export function redactSensitiveText(text: string, sensitiveValues: readonly string[]): string {
  if (typeof text !== 'string') {
    fail('invalid_input', '脱敏目标必须是字符串');
  }
  let result = text;
  for (const value of normalizeSensitiveValues(sensitiveValues)) {
    result = result.split(value).join(`[REDACTED:${sha256Hex(value).slice(0, 12)}]`);
  }
  return result;
}

/** 复核：文本中不得再出现任何敏感值，否则 secret_leak（不脱敏放行）。 */
export function assertNoSensitiveText(
  text: string,
  sensitiveValues: readonly string[],
  label: string,
): void {
  for (const value of normalizeSensitiveValues(sensitiveValues)) {
    if (text.includes(value)) {
      fail('secret_leak', `${label} 仍包含敏感值，拒绝写出`, sha256Hex(value).slice(0, 12));
    }
  }
}

/**
 * 凭据键名形状（JSON 键：token/auth/authorization/password/secret/credential/cookie/
 * apikey）。值已被脱敏为 [REDACTED:…] 占位符时不命中——占位符不含秘密本身；
 * 未登记敏感值的真实凭据值仍拒绝写出。
 */
const CREDENTIAL_KEY_TEXT_PATTERN =
  /"(?:authorization|auth|token|password|secret|credential|cookie|api[_-]?key)s?"\s*:\s*(?!(?:"\[REDACTED:|\[REDACTED:))/gi;
/** Bearer 认证头形态（值域不含 [REDACTED 占位符，脱敏后不再命中）。 */
const BEARER_TEXT_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
/** 开发机主目录绝对路径（macOS/Linux/Windows）。 */
const DEVELOPER_PATH_PATTERNS: readonly RegExp[] = [
  /\/Users\/[^\s"'`,;:|]+/g,
  /\/home\/[^\s"'`,;:|]+/g,
  /[A-Za-z]:\\Users\\[^\s"'`,;|]+/g,
];

/** 扫描凭据形状，返回命中描述（无命中为空）；命中即拒绝写出。 */
export function scanTextForCredentialShapes(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(CREDENTIAL_KEY_TEXT_PATTERN)) {
    hits.push(`凭据形状键：${match[0].slice(0, 40)}`);
  }
  for (const match of text.matchAll(BEARER_TEXT_PATTERN)) {
    hits.push(`Bearer 认证头形状：${match[0].slice(0, 24)}…`);
  }
  return hits;
}

export function assertNoCredentialShapesInText(text: string, label: string): void {
  const hits = scanTextForCredentialShapes(text);
  if (hits.length > 0) {
    fail('secret_leak', `${label} 含凭据形状，拒绝写出（不得复制认证文件或认证头）`, hits[0]);
  }
}

/** 扫描开发机绝对路径，返回命中（无命中为空）；命中即拒绝写出。 */
export function scanTextForDeveloperPaths(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of DEVELOPER_PATH_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      hits.push(match[0].slice(0, 80));
    }
  }
  return hits;
}

export function assertNoDeveloperPathsInText(text: string, label: string): void {
  const hits = scanTextForDeveloperPaths(text);
  if (hits.length > 0) {
    fail(
      'absolute_path_leak',
      `${label} 含开发机绝对路径，拒绝写出（应使用 <repo>/… 逻辑位置或登记为敏感值脱敏）`,
      hits[0],
    );
  }
}

/* ------------------------------------------------------------------ *
 * 检查清单读取与冻结顺序
 * ------------------------------------------------------------------ */

function requiredItems(checklist: P03Checklist): readonly P03ChecklistItem[] {
  if (!isPlainObject(checklist) || !Array.isArray(checklist.items)) {
    fail('invalid_input', '检查清单必须是含 items 数组的对象');
  }
  const required = checklist.items.filter((item) => item.group !== 'deferred');
  const ids = required.map((item) => item.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    fail('invalid_input', '检查清单含重复必需检查 ID');
  }
  if (
    ids.length !== P03_REQUIRED_CHECK_IDS.length ||
    ids.some((id, index) => id !== P03_REQUIRED_CHECK_IDS[index])
  ) {
    fail('invalid_input', '检查清单必需项与冻结顺序不一致（不得删减、顶替或重排）');
  }
  for (const item of checklist.items) {
    if (typeof item.id !== 'string' || item.id.length === 0) {
      fail('invalid_input', '检查清单条目缺少有效 ID');
    }
    if (item.layer !== 'unit' && item.layer !== 'feature-integration' && item.layer !== 'phase-acceptance') {
      fail('invalid_input', `检查 ${item.id} 的验证层次非法：${String(item.layer)}`);
    }
  }
  return required;
}

function deferredItems(checklist: P03Checklist): readonly P03ChecklistItem[] {
  return checklist.items.filter((item) => item.group === 'deferred');
}

function requiredById(checklist: P03Checklist): ReadonlyMap<string, P03ChecklistItem> {
  return new Map(requiredItems(checklist).map((item) => [item.id, item]));
}

function isEvidenceCategory(value: unknown): value is P03EvidenceCategory {
  return typeof value === 'string' && (P03_EVIDENCE_CATEGORIES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * 检查结果与严格聚合
 * ------------------------------------------------------------------ */

export type P03CheckStatus = 'pass' | 'fail' | 'not_run';
export type P03NotRunReason =
  | 'missing_result'
  | 'preparation_failure'
  | 'missing_output'
  | 'timeout'
  | 'skipped';
export type P03ExecutionMode = 'fake' | 'live';

const CHECK_STATUSES: readonly P03CheckStatus[] = ['pass', 'fail', 'not_run'];
const NOT_RUN_REASONS: readonly P03NotRunReason[] = [
  'missing_result',
  'preparation_failure',
  'missing_output',
  'timeout',
  'skipped',
];

export interface P03AssertionRecord {
  readonly id: string;
  readonly satisfied: boolean;
}

export interface P03CheckResultInput {
  readonly checkId: string;
  readonly status: P03CheckStatus;
  /** status=not_run 时必填的明确分类；其他状态不得携带。 */
  readonly notRunReason?: P03NotRunReason;
  /** 执行身份：P03 冻结 Fake（realModel=false / network=denied），live 视为混淆。 */
  readonly executionMode: P03ExecutionMode;
  /** 真实状态断言（自由文本 ID + 实际断言结果）；pass 至少一条且全部满足。 */
  readonly assertions?: readonly P03AssertionRecord[];
  /** 副作用核对：真实 DB/Git/进程/文件副作用符合预期（负例为无意外副作用）。 */
  readonly sideEffectVerified?: boolean;
  readonly durationMs?: number;
  readonly detail?: string;
  /** 报告内相对证据路径（必须以 evidence/ 开头）。 */
  readonly evidenceRefs?: readonly string[];
}

export interface P03AggregatedCheck {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly layer: P03Layer;
  readonly fr: readonly string[];
  readonly acceptanceRefs: readonly string[];
  /** 检查清单冻结的必需断言文本（供审阅者逐条核对）。 */
  readonly checklistAssertions: readonly string[];
  /** 检查清单冻结的证据类别。 */
  readonly evidenceCategories: readonly string[];
  readonly coverage: 'partial' | null;
  readonly coverageNote: string | null;
  readonly status: P03CheckStatus;
  readonly notRunReason: P03NotRunReason | null;
  readonly executionMode: P03ExecutionMode;
  readonly assertions: readonly P03AssertionRecord[];
  readonly sideEffectVerified: boolean | null;
  readonly durationMs: number | null;
  readonly detail: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface P03AggregationCounts {
  readonly pass: number;
  readonly fail: number;
  readonly not_run: number;
  readonly total: number;
}

export interface P03Aggregation {
  readonly checks: readonly P03AggregatedCheck[];
  readonly counts: P03AggregationCounts;
  /** pass 仅当全部必需检查均为 pass；空结果集聚合为 fail。 */
  readonly conclusion: 'pass' | 'fail';
  /** 人类可读的未通过原因清单（fail/not_run/降级）。 */
  readonly problems: readonly string[];
}

function assertOptionalDuration(
  value: unknown,
  label: string,
  kind: P03ReportErrorKind,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(kind, `${label} 必须是非负有限毫秒数`);
  }
  return value;
}

function readAssertions(
  value: unknown,
  label: string,
  kind: P03ReportErrorKind,
): P03AssertionRecord[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(kind, `${label} 必须是断言数组`);
  }
  const seen = new Set<string>();
  const assertions: P03AssertionRecord[] = [];
  for (const [index, raw] of (value as unknown[]).entries()) {
    if (!isPlainObject(raw)) {
      fail(kind, `${label}[${index}] 必须是对象`);
    }
    const id = raw.id;
    if (typeof id !== 'string' || id.length === 0) {
      fail(kind, `${label}[${index}].id 必须是非空字符串`);
    }
    if (seen.has(id)) {
      fail(kind, `${label} 断言 ID 重复：${id}`);
    }
    seen.add(id);
    if (typeof raw.satisfied !== 'boolean') {
      fail(kind, `${label}[${index}].satisfied 必须是布尔值`);
    }
    assertions.push({ id, satisfied: raw.satisfied });
  }
  return assertions;
}

function readOptionalBoolean(
  value: unknown,
  label: string,
  kind: P03ReportErrorKind,
): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'boolean') {
    fail(kind, `${label} 必须是布尔值`);
  }
  return value;
}

function readEvidenceRefs(
  value: unknown,
  label: string,
  kind: P03ReportErrorKind,
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(kind, `${label} 必须是字符串数组`);
  }
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const entry of value as unknown[]) {
    const normalized = assertEvidenceReportPath(entry, label);
    if (seen.has(normalized)) {
      fail('duplicate_evidence', `${label} 存在重复证据引用：${normalized}`);
    }
    seen.add(normalized);
    refs.push(normalized);
  }
  return refs;
}

/**
 * 严格聚合检查结果：清单顺序固定，未知/重复 ID 拒绝，缺失必需项记
 * not_run/missing_result。正常与预期负例的 pass 均要求真实断言全部满足、
 * 副作用核对通过且执行身份为 Fake；不满足即降级 fail（不静默通过）。
 */
export function aggregateP03CheckResults(
  checklist: P03Checklist,
  results: readonly P03CheckResultInput[],
): P03Aggregation {
  if (!Array.isArray(results)) {
    fail('invalid_input', '检查结果必须是数组');
  }
  const definitions = requiredById(checklist);
  const byId = new Map<string, P03AggregatedCheck>();
  const problems: string[] = [];

  for (const raw of results as unknown[]) {
    if (!isPlainObject(raw)) {
      fail('invalid_result', '检查结果条目必须是对象');
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.checkId !== 'string' || entry.checkId.length === 0) {
      fail('invalid_result', '检查结果缺少有效的 checkId');
    }
    const checkId = entry.checkId;
    const definition = definitions.get(checkId);
    if (definition === undefined) {
      fail('unknown_check', `未知检查 ID：${checkId}`, checkId);
    }
    if (byId.has(checkId)) {
      fail('duplicate_check', `重复提交的检查 ID：${checkId}`, checkId);
    }
    if (typeof entry.status !== 'string' || !CHECK_STATUSES.includes(entry.status as P03CheckStatus)) {
      fail('invalid_result', `检查 ${checkId} 的 status 非法：${String(entry.status)}`);
    }
    const status = entry.status as P03CheckStatus;
    const notRunReasonRaw = entry.notRunReason;
    let notRunReason: P03NotRunReason | null = null;
    if (status === 'not_run') {
      if (
        typeof notRunReasonRaw !== 'string' ||
        !NOT_RUN_REASONS.includes(notRunReasonRaw as P03NotRunReason)
      ) {
        fail(
          'invalid_result',
          `检查 ${checkId} 为 not_run 时必须携带明确分类（${NOT_RUN_REASONS.join('/')}）`,
        );
      }
      notRunReason = notRunReasonRaw as P03NotRunReason;
    } else if (notRunReasonRaw !== undefined && notRunReasonRaw !== null) {
      fail('invalid_result', `检查 ${checkId} 非 not_run 状态不得携带 notRunReason`);
    }
    if (entry.executionMode !== 'fake' && entry.executionMode !== 'live') {
      fail('invalid_result', `检查 ${checkId} 的 executionMode 必须是 fake 或 live`);
    }
    const detail = entry.detail === undefined || entry.detail === null ? null : entry.detail;
    if (detail !== null && typeof detail !== 'string') {
      fail('invalid_result', `检查 ${checkId} 的 detail 必须是字符串`);
    }
    byId.set(checkId, {
      id: definition.id,
      group: definition.group,
      title: definition.title,
      layer: definition.layer,
      fr: [...definition.fr],
      acceptanceRefs: [...definition.acceptanceRefs],
      checklistAssertions: [...definition.assertions],
      evidenceCategories: [...definition.evidence],
      coverage: definition.coverage ?? null,
      coverageNote: definition.coverageNote ?? null,
      status,
      notRunReason,
      executionMode: entry.executionMode,
      assertions: readAssertions(entry.assertions, `检查 ${checkId} 的 assertions`, 'invalid_result'),
      sideEffectVerified: readOptionalBoolean(
        entry.sideEffectVerified,
        `检查 ${checkId} 的 sideEffectVerified`,
        'invalid_result',
      ),
      durationMs: assertOptionalDuration(entry.durationMs, `检查 ${checkId} 的 durationMs`, 'invalid_result'),
      detail: detail as string | null,
      evidenceRefs: readEvidenceRefs(entry.evidenceRefs, `检查 ${checkId} 的 evidenceRefs`, 'invalid_result'),
    });
  }

  for (const definition of requiredItems(checklist)) {
    if (byId.has(definition.id)) {
      continue;
    }
    byId.set(definition.id, {
      id: definition.id,
      group: definition.group,
      title: definition.title,
      layer: definition.layer,
      fr: [...definition.fr],
      acceptanceRefs: [...definition.acceptanceRefs],
      checklistAssertions: [...definition.assertions],
      evidenceCategories: [...definition.evidence],
      coverage: definition.coverage ?? null,
      coverageNote: definition.coverageNote ?? null,
      status: 'not_run',
      notRunReason: 'missing_result',
      executionMode: 'fake',
      assertions: [],
      sideEffectVerified: null,
      durationMs: null,
      detail: null,
      evidenceRefs: [],
    });
    problems.push(`${definition.id}: 未提交结果（not_run/missing_result）`);
  }

  const checks: P03AggregatedCheck[] = [];
  for (const definition of requiredItems(checklist)) {
    const entry = byId.get(definition.id) as P03AggregatedCheck;
    if (entry.status === 'pass') {
      const downgradeReasons: string[] = [];
      if (entry.assertions.length === 0) {
        downgradeReasons.push('缺少真实状态断言（detail/logger 文本不能替代断言）');
      } else if (entry.assertions.some((assertion) => !assertion.satisfied)) {
        downgradeReasons.push('断言未满足');
      }
      if (entry.sideEffectVerified !== true) {
        downgradeReasons.push('副作用核对未通过');
      }
      if (entry.executionMode !== 'fake' || P03_FAKE_IDENTITY.realModel !== false) {
        downgradeReasons.push('真假执行混淆：P03 Fake/无网络验收不得使用 live 执行');
      }
      if (downgradeReasons.length > 0) {
        const note = `不计为通过：${downgradeReasons.join('；')}`;
        checks.push({
          ...entry,
          status: 'fail',
          detail: entry.detail === null ? note : `${entry.detail}；${note}`,
        });
        problems.push(`${entry.id}: ${note}`);
        continue;
      }
    }
    checks.push(entry);
    if (entry.status === 'fail') {
      problems.push(`${entry.id}: fail${entry.detail !== null ? ` — ${entry.detail}` : ''}`);
    } else if (entry.status === 'not_run' && entry.notRunReason !== 'missing_result') {
      problems.push(`${entry.id}: not_run/${String(entry.notRunReason)}`);
    }
  }

  const counts: P03AggregationCounts = {
    pass: checks.filter((check) => check.status === 'pass').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    not_run: checks.filter((check) => check.status === 'not_run').length,
    total: checks.length,
  };
  const conclusion: 'pass' | 'fail' = counts.pass === counts.total ? 'pass' : 'fail';
  return { checks, counts, conclusion, problems };
}

/* ------------------------------------------------------------------ *
 * 报告输入、证据与清理
 * ------------------------------------------------------------------ */

export interface P03CommandRecord {
  readonly label: string;
  /** 显式 argv（不经 Shell 拼接；绝对路径须以逻辑位置或脱敏值替代）。 */
  readonly argv: readonly string[];
  /** 逻辑 cwd（<repo> 等形式），不记录个人绝对路径。 */
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut?: boolean;
}

export interface P03CleanupRecord {
  /** 临时资源清理已完成并确认。 */
  readonly confirmed: boolean;
  /** 受管进程组已确认消失（清理前核对）。 */
  readonly processesGone: boolean;
  /** cleanup manifest 证据引用（evidence/ 下，category=manifest，清理前导出）。 */
  readonly manifestEvidenceRefs: readonly string[];
  readonly notes?: readonly string[];
}

export interface P03ProductReportRef {
  readonly featureId: string;
  readonly label: string;
  /** 逻辑命令（如 shiploop feature report <featureId> --project <projectId> --json）。 */
  readonly command: string;
  /** 完整产品 Feature 执行报告的证据引用（category=report）。 */
  readonly evidenceRef: string;
}

export interface P03OpenIssue {
  readonly id: string;
  readonly summary: string;
  /** 阻塞项使阶段结论非零；非阻塞项仅可见。 */
  readonly blocking: boolean;
}

export interface P03EvidenceManifestEntry {
  /** 稳定证据身份（默认为 path）；重复身份拒绝。 */
  readonly identity: string;
  readonly category: P03EvidenceCategory;
  /** 报告目录内相对路径（evidence/ 前缀）。 */
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly checkId: string | null;
  /** 是否在临时资源清理前导出（SQLite/Git/进程/manifest 必须为 true）。 */
  readonly capturedBeforeCleanup: boolean;
}

export interface P03ReportPlan {
  readonly phaseId: string;
  readonly stepId: string;
  readonly title: string;
  readonly scope: string;
  readonly version: string;
  readonly contractDoc: string;
  /** 输入计划（PRD/Phase 计划）内容摘要。 */
  readonly digestSha256: string;
  /** 检查清单内容摘要。 */
  readonly checklistDigestSha256: string;
}

export interface P03PhaseReportInput {
  readonly runId: string;
  /** ISO 8601 UTC（…Z）。 */
  readonly generatedAtUtc: string;
  readonly plan: P03ReportPlan;
  readonly git: {
    readonly commit: string;
    readonly worktree: 'clean' | 'dirty';
    readonly branch: string | null;
    readonly priorBaselines: readonly {
      phase: string;
      branch: string;
      tipCommit: string;
    }[];
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
  readonly commands: readonly P03CommandRecord[];
  readonly results: readonly P03CheckResultInput[];
  readonly cleanup: P03CleanupRecord;
  /** 完整产品 Feature 执行报告引用（与阶段报告分层）。 */
  readonly productReports: readonly P03ProductReportRef[];
  readonly openIssues?: readonly P03OpenIssue[];
  readonly knownLimitations?: readonly string[];
  readonly stateDigests?: {
    readonly businessInputSha256?: string;
    readonly sqliteSha256?: string;
    readonly gitSha256?: string;
    readonly codeSha256?: string;
  };
}

export interface P03DeferredEntry {
  readonly id: string;
  readonly title: string;
  readonly status: P03DeferredStatus;
}

export interface P03AcceptanceReport {
  readonly reportSchemaVersion: number;
  readonly reportLayer: typeof P03_REPORT_LAYER;
  readonly runId: string;
  readonly generatedAtUtc: string;
  readonly plan: P03ReportPlan;
  readonly git: P03PhaseReportInput['git'];
  readonly platform: P03PhaseReportInput['platform'];
  readonly tools: P03PhaseReportInput['tools'];
  readonly fakeIdentity: {
    readonly provider: string;
    readonly model: string;
    readonly realModel: boolean;
    readonly network: string;
  };
  readonly commands: readonly P03CommandRecord[];
  readonly checks: readonly P03AggregatedCheck[];
  readonly counts: P03AggregationCounts;
  readonly conclusion: 'pass' | 'fail';
  readonly evidence: readonly P03EvidenceManifestEntry[];
  readonly cleanup: Required<P03CleanupRecord>;
  readonly productReports: readonly P03ProductReportRef[];
  readonly deferred: readonly P03DeferredEntry[];
  readonly openIssues: readonly P03OpenIssue[];
  readonly knownLimitations: readonly string[];
  readonly stateDigests: NonNullable<P03PhaseReportInput['stateDigests']>;
}

/* ---------------------------- 输入校验 ---------------------------- */

function assertSha256Digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEX_64.test(value)) {
    fail('invalid_input', `${label} 必须是 64 位小写十六进制 SHA-256`);
  }
  return value;
}

function assertCommit(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEX_40.test(value)) {
    fail('invalid_input', `${label} 必须是 40 位小写十六进制 commit`);
  }
  return value;
}

function assertUtcIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UTC_ISO_PATTERN.test(value)) {
    fail('invalid_input', `${label} 必须是 ISO 8601 UTC 时间（…Z）`);
  }
  return value;
}

function validateCommands(value: unknown): readonly P03CommandRecord[] {
  if (!Array.isArray(value)) {
    fail('invalid_input', 'commands 必须是数组');
  }
  return (value as unknown[]).map((raw, index) => {
    const label = `commands[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_input', `${label} 必须是对象`);
    }
    if (!Array.isArray(raw.argv) || raw.argv.length === 0) {
      fail('invalid_input', `${label}.argv 必须是非空字符串数组`);
    }
    for (const arg of raw.argv as unknown[]) {
      if (typeof arg !== 'string' || arg.length === 0) {
        fail('invalid_input', `${label}.argv 只允许非空字符串`);
      }
    }
    if (raw.exitCode !== null && (typeof raw.exitCode !== 'number' || !Number.isInteger(raw.exitCode))) {
      fail('invalid_input', `${label}.exitCode 必须是整数或 null`);
    }
    const duration = assertOptionalDuration(raw.durationMs, `${label}.durationMs`, 'invalid_input');
    if (duration === null) {
      fail('invalid_input', `${label}.durationMs 必填`);
    }
    if (raw.timedOut !== undefined && typeof raw.timedOut !== 'boolean') {
      fail('invalid_input', `${label}.timedOut 必须是布尔值`);
    }
    return {
      label: assertNonEmptyString(raw.label, `${label}.label`),
      argv: [...(raw.argv as readonly string[])],
      cwd: assertLogicalLocation(raw.cwd, `${label}.cwd`),
      exitCode: raw.exitCode as number | null,
      durationMs: duration,
      ...(raw.timedOut !== undefined ? { timedOut: raw.timedOut as boolean } : {}),
    };
  });
}

function validateCleanup(value: unknown): Required<P03CleanupRecord> {
  if (!isPlainObject(value)) {
    fail('invalid_input', 'cleanup 必须是对象');
  }
  if (typeof value.confirmed !== 'boolean') {
    fail('invalid_input', 'cleanup.confirmed 必须是布尔值');
  }
  if (typeof value.processesGone !== 'boolean') {
    fail('invalid_input', 'cleanup.processesGone 必须是布尔值');
  }
  if (!Array.isArray(value.manifestEvidenceRefs)) {
    fail('invalid_input', 'cleanup.manifestEvidenceRefs 必须是数组');
  }
  const seen = new Set<string>();
  const refs = (value.manifestEvidenceRefs as unknown[]).map((ref, index) => {
    const normalized = assertEvidenceReportPath(ref, `cleanup.manifestEvidenceRefs[${index}]`);
    if (seen.has(normalized)) {
      fail('duplicate_evidence', `cleanup.manifestEvidenceRefs 重复：${normalized}`);
    }
    seen.add(normalized);
    return normalized;
  });
  const notes = value.notes;
  if (notes !== undefined) {
    if (!Array.isArray(notes)) {
      fail('invalid_input', 'cleanup.notes 必须是字符串数组');
    }
    for (const [index, note] of (notes as unknown[]).entries()) {
      assertNonEmptyString(note, `cleanup.notes[${index}]`);
    }
  }
  return {
    confirmed: value.confirmed,
    processesGone: value.processesGone,
    manifestEvidenceRefs: refs,
    notes: [...((notes as readonly string[] | undefined) ?? [])],
  };
}

function validateProductReports(value: unknown): readonly P03ProductReportRef[] {
  if (!Array.isArray(value)) {
    fail('invalid_input', 'productReports 必须是数组');
  }
  const seenFeature = new Set<string>();
  const seenEvidence = new Set<string>();
  return (value as unknown[]).map((raw, index) => {
    const label = `productReports[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_input', `${label} 必须是对象`);
    }
    const featureId = assertNonEmptyString(raw.featureId, `${label}.featureId`);
    if (seenFeature.has(featureId)) {
      fail('duplicate_evidence', `${label}.featureId 重复：${featureId}`);
    }
    seenFeature.add(featureId);
    const evidenceRef = assertEvidenceReportPath(raw.evidenceRef, `${label}.evidenceRef`);
    if (seenEvidence.has(evidenceRef)) {
      fail('duplicate_evidence', `${label}.evidenceRef 重复：${evidenceRef}`);
    }
    seenEvidence.add(evidenceRef);
    return {
      featureId,
      label: assertNonEmptyString(raw.label, `${label}.label`),
      command: assertNonEmptyString(raw.command, `${label}.command`),
      evidenceRef,
    };
  });
}

function validateOpenIssues(value: unknown): readonly P03OpenIssue[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail('invalid_input', 'openIssues 必须是数组');
  }
  const seen = new Set<string>();
  return (value as unknown[]).map((raw, index) => {
    const label = `openIssues[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_input', `${label} 必须是对象`);
    }
    const id = assertNonEmptyString(raw.id, `${label}.id`);
    if (seen.has(id)) {
      fail('invalid_input', `${label}.id 重复：${id}`);
    }
    seen.add(id);
    if (typeof raw.blocking !== 'boolean') {
      fail('invalid_input', `${label}.blocking 必须是布尔值`);
    }
    return {
      id,
      summary: assertNonEmptyString(raw.summary, `${label}.summary`),
      blocking: raw.blocking,
    };
  });
}

function validateReportInput(input: P03PhaseReportInput): void {
  if (!isPlainObject(input)) {
    fail('invalid_input', '报告输入必须是对象');
  }
  assertValidRunId(input.runId);
  assertUtcIso(input.generatedAtUtc, 'generatedAtUtc');

  if (!isPlainObject(input.plan)) {
    fail('invalid_input', 'plan 必须是对象');
  }
  assertNonEmptyString(input.plan.phaseId, 'plan.phaseId');
  assertNonEmptyString(input.plan.stepId, 'plan.stepId');
  assertNonEmptyString(input.plan.title, 'plan.title');
  assertNonEmptyString(input.plan.scope, 'plan.scope');
  assertNonEmptyString(input.plan.version, 'plan.version');
  assertSafeReportRelativePath(input.plan.contractDoc, 'plan.contractDoc');
  assertSha256Digest(input.plan.digestSha256, 'plan.digestSha256');
  assertSha256Digest(input.plan.checklistDigestSha256, 'plan.checklistDigestSha256');

  if (!isPlainObject(input.git)) {
    fail('invalid_input', 'git 必须是对象');
  }
  assertCommit(input.git.commit, 'git.commit');
  if (input.git.worktree !== 'clean' && input.git.worktree !== 'dirty') {
    fail('invalid_input', 'git.worktree 必须是 clean 或 dirty');
  }
  if (input.git.branch !== null && typeof input.git.branch !== 'string') {
    fail('invalid_input', 'git.branch 必须是字符串或 null');
  }
  if (!Array.isArray(input.git.priorBaselines)) {
    fail('invalid_input', 'git.priorBaselines 必须是数组');
  }
  for (const [index, baseline] of input.git.priorBaselines.entries()) {
    if (!isPlainObject(baseline)) {
      fail('invalid_input', `git.priorBaselines[${index}] 必须是对象`);
    }
    assertNonEmptyString(baseline.phase, `git.priorBaselines[${index}].phase`);
    assertNonEmptyString(baseline.branch, `git.priorBaselines[${index}].branch`);
    assertCommit(baseline.tipCommit, `git.priorBaselines[${index}].tipCommit`);
  }

  if (!isPlainObject(input.platform)) {
    fail('invalid_input', 'platform 必须是对象');
  }
  assertNonEmptyString(input.platform.system, 'platform.system');
  assertNonEmptyString(input.platform.release, 'platform.release');
  assertNonEmptyString(input.platform.arch, 'platform.arch');

  if (!isPlainObject(input.tools)) {
    fail('invalid_input', 'tools 必须是对象');
  }
  for (const key of ['node', 'npm', 'git', 'sqlite', 'betterSqlite3', 'drizzleOrm'] as const) {
    assertNonEmptyString(input.tools[key], `tools.${key}`);
  }

  validateCommands(input.commands);
  validateCleanup(input.cleanup);
  validateProductReports(input.productReports);
  validateOpenIssues(input.openIssues);

  if (input.knownLimitations !== undefined) {
    if (!Array.isArray(input.knownLimitations)) {
      fail('invalid_input', 'knownLimitations 必须是字符串数组');
    }
    for (const [index, item] of input.knownLimitations.entries()) {
      assertNonEmptyString(item, `knownLimitations[${index}]`);
    }
  }

  if (input.stateDigests !== undefined) {
    if (!isPlainObject(input.stateDigests)) {
      fail('invalid_input', 'stateDigests 必须是对象');
    }
    for (const key of [
      'businessInputSha256',
      'sqliteSha256',
      'gitSha256',
      'codeSha256',
    ] as const) {
      const value = input.stateDigests[key];
      if (value !== undefined) {
        assertSha256Digest(value, `stateDigests.${key}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 证据清单
 * ------------------------------------------------------------------ */

function normalizeEvidenceManifest(
  checklist: P03Checklist,
  value: unknown,
): readonly P03EvidenceManifestEntry[] {
  if (!Array.isArray(value)) {
    fail('invalid_input', '证据清单必须是数组');
  }
  const definitions = requiredById(checklist);
  const identities = new Set<string>();
  const paths = new Set<string>();
  return (value as unknown[]).map((raw, index) => {
    const label = `证据清单[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_input', `${label} 必须是对象`);
    }
    const identity = assertNonEmptyString(raw.identity, `${label}.identity`);
    if (identities.has(identity)) {
      fail('duplicate_evidence', `${label}.identity 重复：${identity}`);
    }
    identities.add(identity);
    const category = raw.category;
    if (!isEvidenceCategory(category)) {
      fail('invalid_input', `${label}.category 非法：${String(raw.category)}`);
    }
    const path = assertEvidenceReportPath(raw.path, `${label}.path`);
    if (paths.has(path)) {
      fail('duplicate_evidence', `${label}.path 重复：${path}`);
    }
    paths.add(path);
    if (raw.checkId !== null && raw.checkId !== undefined) {
      if (typeof raw.checkId !== 'string' || !definitions.has(raw.checkId)) {
        fail('unknown_check', `${label}.checkId 未知：${String(raw.checkId)}`);
      }
    }
    if (typeof raw.capturedBeforeCleanup !== 'boolean') {
      fail('invalid_input', `${label}.capturedBeforeCleanup 必须是布尔值`);
    }
    if (
      typeof raw.sizeBytes !== 'number' ||
      !Number.isInteger(raw.sizeBytes) ||
      raw.sizeBytes < 0
    ) {
      fail('invalid_input', `${label}.sizeBytes 必须是非负整数`);
    }
    return {
      identity,
      category,
      path,
      sha256: assertSha256Digest(raw.sha256, `${label}.sha256`),
      sizeBytes: raw.sizeBytes,
      checkId: (raw.checkId as string | null | undefined) ?? null,
      capturedBeforeCleanup: raw.capturedBeforeCleanup,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 阶段结论门禁（检查 + 证据 + 清理 + 产品报告 + 遗留问题）
 * ------------------------------------------------------------------ */

export function evaluateP03PhaseConclusion(input: {
  readonly checklist: P03Checklist;
  readonly aggregation: P03Aggregation;
  readonly evidence: readonly P03EvidenceManifestEntry[];
  readonly cleanup: P03CleanupRecord;
  readonly productReports: readonly P03ProductReportRef[];
  readonly openIssues?: readonly P03OpenIssue[];
}): { readonly conclusion: 'pass' | 'fail'; readonly problems: readonly string[] } {
  const problems: string[] = [...input.aggregation.problems];
  const byPath = new Map(input.evidence.map((entry) => [entry.path, entry]));

  // 1) 每项必需检查必须有证据，且覆盖检查清单声明的证据类别。
  for (const check of input.aggregation.checks) {
    if (check.evidenceRefs.length === 0) {
      problems.push(`${check.id}: 缺少证据引用`);
    }
    for (const ref of check.evidenceRefs) {
      const entry = byPath.get(ref);
      if (entry === undefined) {
        problems.push(`${check.id}: 证据不在清单中：${ref}`);
        continue;
      }
      if (entry.checkId !== null && entry.checkId !== check.id) {
        problems.push(`${check.id}: 证据 ${ref} 归属 ${entry.checkId}，不得跨检查复用`);
      }
    }
    for (const category of check.evidenceCategories) {
      const covered = check.evidenceRefs.some((ref) => byPath.get(ref)?.category === category);
      if (!covered) {
        problems.push(`${check.id}: 证据类别未覆盖：${category}`);
      }
    }
  }
  for (const entry of input.evidence) {
    if (entry.checkId === null) {
      continue;
    }
    const check = input.aggregation.checks.find((candidate) => candidate.id === entry.checkId);
    if (check === undefined || !check.evidenceRefs.includes(entry.path)) {
      problems.push(`${entry.checkId}: 证据 ${entry.path} 未被检查引用（重复/孤立证据不静默聚合）`);
    }
  }

  // 2) 清理前必须导出 SQLite/Git/进程与 cleanup manifest 证据。
  for (const category of P03_PHASE_EVIDENCE_CATEGORIES) {
    const covered = input.evidence.some(
      (entry) => entry.category === category && entry.capturedBeforeCleanup,
    );
    if (!covered) {
      problems.push(`缺少清理前导出的阶段证据类别：${category}`);
    }
  }

  // 3) 清理确认与受管进程组消失。
  if (!input.cleanup.confirmed) {
    problems.push('cleanup 未确认：临时资源清理未确认前阶段不得判定通过');
  }
  if (!input.cleanup.processesGone) {
    problems.push('受管进程组未确认消失，阶段不得判定通过');
  }
  if (input.cleanup.manifestEvidenceRefs.length === 0) {
    problems.push('缺少 cleanup manifest 证据');
  }
  for (const ref of input.cleanup.manifestEvidenceRefs) {
    const entry = byPath.get(ref);
    if (entry === undefined) {
      problems.push(`cleanup manifest 证据不在清单中：${ref}`);
      continue;
    }
    if (entry.category !== 'manifest') {
      problems.push(`cleanup manifest 证据类别必须是 manifest：${ref}`);
    }
    if (!entry.capturedBeforeCleanup) {
      problems.push(`cleanup manifest 证据必须在清理前导出：${ref}`);
    }
  }

  // 4) 完整产品 Feature 执行报告引用（分层可追溯）。
  if (input.productReports.length === 0) {
    problems.push('缺少产品 Feature 报告（完整执行报告）引用：阶段报告与产品报告必须分层可追溯');
  }
  for (const product of input.productReports) {
    const entry = byPath.get(product.evidenceRef);
    if (entry === undefined) {
      problems.push(`产品 Feature 报告证据不在清单中：${product.featureId}`);
      continue;
    }
    if (entry.category !== 'report') {
      problems.push(`产品 Feature 报告证据类别必须是 report：${product.featureId}`);
    }
    if (!entry.capturedBeforeCleanup) {
      problems.push(`产品 Feature 报告证据必须在清理前导出：${product.featureId}`);
    }
  }

  // 5) 阻塞遗留问题使阶段非零；非阻塞项仅可见。
  for (const issue of input.openIssues ?? []) {
    if (issue.blocking) {
      problems.push(`阻塞遗留问题：${issue.id} — ${issue.summary}`);
    }
  }

  return { conclusion: problems.length === 0 ? 'pass' : 'fail', problems };
}

/**
 * 阶段退出码：必需检查结论 pass、证据/报告重验成功且 cleanup 已确认才为 0。
 */
export function computeP03PhaseExitCode(input: {
  readonly conclusion: 'pass' | 'fail';
  readonly evidenceOk: boolean;
  readonly reportWritten: boolean;
  readonly cleanupConfirmed: boolean;
}): number {
  return input.conclusion === 'pass' &&
    input.evidenceOk &&
    input.reportWritten &&
    input.cleanupConfirmed
    ? 0
    : 1;
}

/* ------------------------------------------------------------------ *
 * 报告装配与严格 Schema 校验
 * ------------------------------------------------------------------ */

const REPORT_TOP_LEVEL_KEYS = [
  'reportSchemaVersion',
  'reportLayer',
  'runId',
  'generatedAtUtc',
  'plan',
  'git',
  'platform',
  'tools',
  'fakeIdentity',
  'commands',
  'checks',
  'counts',
  'conclusion',
  'evidence',
  'cleanup',
  'productReports',
  'deferred',
  'openIssues',
  'knownLimitations',
  'stateDigests',
] as const;

const CHECK_ENTRY_KEYS = [
  'id',
  'group',
  'title',
  'layer',
  'fr',
  'acceptanceRefs',
  'checklistAssertions',
  'evidenceCategories',
  'coverage',
  'coverageNote',
  'status',
  'notRunReason',
  'executionMode',
  'assertions',
  'sideEffectVerified',
  'durationMs',
  'detail',
  'evidenceRefs',
] as const;

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail('invalid_report', `${label} 含未知字段：${key}`);
    }
  }
}

function assertStringArray(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    fail('invalid_report', `${label} 与检查清单冻结值不一致`);
  }
}

function aggregationFromReportChecks(
  checklist: P03Checklist,
  checks: readonly Record<string, unknown>[],
): P03Aggregation {
  return aggregateP03CheckResults(
    checklist,
    checks.map((entry) => {
      const run: P03CheckResultInput = {
        checkId: entry.id as string,
        status: entry.status as P03CheckStatus,
        executionMode: entry.executionMode as P03ExecutionMode,
        assertions: entry.assertions as readonly P03AssertionRecord[],
        ...(entry.sideEffectVerified !== null
          ? { sideEffectVerified: entry.sideEffectVerified as boolean }
          : {}),
        ...(entry.notRunReason !== null ? { notRunReason: entry.notRunReason as P03NotRunReason } : {}),
        ...(entry.durationMs !== null ? { durationMs: entry.durationMs as number } : {}),
        ...(entry.detail !== null ? { detail: entry.detail as string } : {}),
        evidenceRefs: entry.evidenceRefs as readonly string[],
      };
      return run;
    }),
  );
}

function validateChecks(
  checklist: P03Checklist,
  value: unknown,
): readonly P03AggregatedCheck[] {
  if (!Array.isArray(value)) {
    fail('invalid_report', 'checks 必须是数组');
  }
  const required = requiredItems(checklist);
  if (value.length !== required.length) {
    fail('invalid_report', `checks 必须恰好 ${required.length} 项（清单冻结顺序）`);
  }
  const seenRefs: string[] = [];
  const rawChecks = value as Record<string, unknown>[];
  rawChecks.forEach((entry, index) => {
    const label = `checks[${index}]`;
    if (!isPlainObject(entry)) {
      fail('invalid_report', `${label} 必须是对象`);
    }
    assertAllowedKeys(entry, CHECK_ENTRY_KEYS, label);
    const definition = required[index] as P03ChecklistItem;
    if (entry.id !== definition.id) {
      fail('invalid_report', `${label}.id 必须是 ${definition.id}（顺序固定），收到：${String(entry.id)}`);
    }
    if (entry.group !== definition.group || entry.title !== definition.title) {
      fail('invalid_report', `${label} 的 group/title 与清单不一致`);
    }
    if (entry.layer !== definition.layer) {
      fail('invalid_report', `${label}.layer 与清单不一致`);
    }
    assertStringArray(entry.fr, definition.fr, `${label}.fr`);
    assertStringArray(entry.acceptanceRefs, definition.acceptanceRefs, `${label}.acceptanceRefs`);
    assertStringArray(
      entry.checklistAssertions,
      definition.assertions,
      `${label}.checklistAssertions`,
    );
    assertStringArray(entry.evidenceCategories, definition.evidence, `${label}.evidenceCategories`);
    if ((definition.coverage ?? null) !== (entry.coverage ?? null)) {
      fail('invalid_report', `${label}.coverage 与清单不一致`);
    }
    if ((definition.coverageNote ?? null) !== (entry.coverageNote ?? null)) {
      fail('invalid_report', `${label}.coverageNote 与清单不一致`);
    }
    if (
      typeof entry.status !== 'string' ||
      !CHECK_STATUSES.includes(entry.status as P03CheckStatus)
    ) {
      fail('invalid_report', `${label}.status 非法：${String(entry.status)}`);
    }
    const status = entry.status as P03CheckStatus;
    if (status === 'not_run') {
      if (
        typeof entry.notRunReason !== 'string' ||
        !NOT_RUN_REASONS.includes(entry.notRunReason as P03NotRunReason)
      ) {
        fail('invalid_report', `${label} 为 not_run 时 notRunReason 必须明确分类`);
      }
    } else if (entry.notRunReason !== null) {
      fail('invalid_report', `${label} 非 not_run 时 notRunReason 必须为 null`);
    }
    if (entry.executionMode !== 'fake' && entry.executionMode !== 'live') {
      fail('invalid_report', `${label}.executionMode 必须是 fake 或 live`);
    }
    readAssertions(entry.assertions, `${label}.assertions`, 'invalid_report');
    if (entry.sideEffectVerified !== null && typeof entry.sideEffectVerified !== 'boolean') {
      fail('invalid_report', `${label}.sideEffectVerified 必须是布尔值或 null`);
    }
    if (entry.durationMs !== null) {
      assertOptionalDuration(entry.durationMs, `${label}.durationMs`, 'invalid_report');
    }
    if (entry.detail !== null && typeof entry.detail !== 'string') {
      fail('invalid_report', `${label}.detail 必须是字符串或 null`);
    }
    const refs = readEvidenceRefs(entry.evidenceRefs, `${label}.evidenceRefs`, 'invalid_report');
    seenRefs.push(...refs);
  });

  // 用严格聚合器复核：pass 的断言/副作用/真假执行门禁不得被绕过。
  const recomputed = aggregationFromReportChecks(checklist, rawChecks);
  for (const [index, check] of recomputed.checks.entries()) {
    if (check.status !== rawChecks[index]?.status) {
      fail('invalid_report', `checks[${index}] 不满足 pass 门禁（断言/副作用/执行身份），不得声明 pass`);
    }
  }
  return recomputed.checks;
}

/**
 * 严格校验报告对象（Schema v1）：版本、分层、字段、清单映射与顺序、断言/副作用
 * 门禁、计数与结论重算、证据身份/路径/hash/size、cleanup 门禁、产品报告引用与
 * deferred/openIssues 一致性。非法报告一律抛 invalid_report / unsafe_path /
 * duplicate_evidence。
 */
export function validateP03AcceptanceReport(
  value: unknown,
  checklist: P03Checklist,
): P03AcceptanceReport {
  if (!isPlainObject(value)) {
    fail('invalid_report', '报告必须是对象');
  }
  const report = value as Record<string, unknown>;
  assertAllowedKeys(report, REPORT_TOP_LEVEL_KEYS, '报告');
  if (report.reportSchemaVersion !== P03_ACCEPTANCE_REPORT_SCHEMA_VERSION) {
    fail(
      'invalid_report',
      `reportSchemaVersion 必须是 ${P03_ACCEPTANCE_REPORT_SCHEMA_VERSION}，收到：${String(report.reportSchemaVersion)}`,
    );
  }
  if (report.reportLayer !== P03_REPORT_LAYER) {
    fail('invalid_report', `reportLayer 必须是 ${P03_REPORT_LAYER}`);
  }
  assertValidRunId(report.runId);
  assertUtcIso(report.generatedAtUtc, 'generatedAtUtc');

  validateReportInput({
    runId: report.runId,
    generatedAtUtc: report.generatedAtUtc,
    plan: report.plan,
    git: report.git,
    platform: report.platform,
    tools: report.tools,
    commands: report.commands,
    results: [],
    cleanup: report.cleanup,
    productReports: report.productReports,
    ...(report.openIssues !== undefined
      ? { openIssues: report.openIssues as readonly P03OpenIssue[] }
      : {}),
    ...(report.knownLimitations !== undefined
      ? { knownLimitations: report.knownLimitations as readonly string[] }
      : {}),
    ...(report.stateDigests !== undefined
      ? { stateDigests: report.stateDigests as P03PhaseReportInput['stateDigests'] }
      : {}),
  } as P03PhaseReportInput);

  if (!isPlainObject(report.fakeIdentity)) {
    fail('invalid_report', 'fakeIdentity 必须是对象');
  }
  for (const key of ['provider', 'model', 'network'] as const) {
    if (report.fakeIdentity[key] !== P03_FAKE_IDENTITY[key]) {
      fail('invalid_report', `fakeIdentity.${key} 与冻结 Fake 身份不一致`);
    }
  }
  if (report.fakeIdentity.realModel !== P03_FAKE_IDENTITY.realModel) {
    fail('invalid_report', 'fakeIdentity.realModel 必须为 false（不得冒充真实模型）');
  }

  const checks = validateChecks(checklist, report.checks);
  const aggregation = aggregationFromReportChecks(
    checklist,
    (report.checks as readonly Record<string, unknown>[]),
  );

  if (!isPlainObject(report.counts)) {
    fail('invalid_report', 'counts 必须是对象');
  }
  for (const key of ['pass', 'fail', 'not_run', 'total'] as const) {
    if ((report.counts as Record<string, unknown>)[key] !== aggregation.counts[key]) {
      fail(
        'invalid_report',
        `counts.${key} 与逐项结果不一致：报告=${String((report.counts as Record<string, unknown>)[key])} 实算=${aggregation.counts[key]}`,
      );
    }
  }

  const evidence = normalizeEvidenceManifest(checklist, report.evidence);
  const byPath = new Map(evidence.map((entry) => [entry.path, entry]));
  for (const check of checks) {
    for (const ref of check.evidenceRefs) {
      if (!byPath.has(ref)) {
        fail('invalid_report', `检查 ${check.id} 引用的证据不在清单中：${ref}`);
      }
    }
  }

  const cleanup = validateCleanup(report.cleanup);
  const productReports = validateProductReports(report.productReports);
  const openIssues = validateOpenIssues(report.openIssues);
  const gate = evaluateP03PhaseConclusion({
    checklist,
    aggregation,
    evidence,
    cleanup,
    productReports,
    openIssues,
  });
  if (report.conclusion !== gate.conclusion) {
    fail(
      'invalid_report',
      `conclusion 与清单/证据/清理门禁不一致：报告=${String(report.conclusion)} 实算=${gate.conclusion}`,
    );
  }

  const deferred = report.deferred;
  if (!Array.isArray(deferred)) {
    fail('invalid_report', 'deferred 必须是数组');
  }
  const expectedDeferred = deferredItems(checklist);
  if (deferred.length !== expectedDeferred.length) {
    fail('invalid_report', 'deferred 必须与清单 deferred 项数量一致');
  }
  deferred.forEach((raw, index) => {
    const label = `deferred[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_report', `${label} 必须是对象`);
    }
    assertAllowedKeys(raw, ['id', 'title', 'status'], label);
    const expected = expectedDeferred[index] as P03ChecklistItem;
    if (raw.id !== expected.id || raw.title !== expected.title) {
      fail('invalid_report', `${label} 与清单 deferred 项不一致`);
    }
    if (raw.status !== (expected.deferredStatus ?? 'not_run')) {
      fail('invalid_report', `${label}.status 与清单 deferred 状态不一致`);
    }
  });

  return report as unknown as P03AcceptanceReport;
}

/**
 * 装配版本化阶段报告：输入校验 → 严格聚合 → 证据/清理/产品报告门禁 →
 * 输出通过完整 Schema 校验的报告对象。
 */
export function buildP03AcceptanceReport(
  checklist: P03Checklist,
  input: P03PhaseReportInput,
  evidenceManifest: readonly P03EvidenceManifestEntry[],
): P03AcceptanceReport {
  validateReportInput(input);
  const aggregation = aggregateP03CheckResults(checklist, input.results);
  const evidence = normalizeEvidenceManifest(checklist, evidenceManifest);

  // 检查引用的证据必须存在；产品报告/cleanup 引用缺失交给门禁判定（报告仍可审阅）。
  const byPath = new Map(evidence.map((entry) => [entry.path, entry]));
  for (const check of aggregation.checks) {
    for (const ref of check.evidenceRefs) {
      if (!byPath.has(ref)) {
        fail('evidence_missing', `检查 ${check.id} 引用的证据不在清单中：${ref}`, ref);
      }
    }
  }

  const cleanup = validateCleanup(input.cleanup);
  const productReports = validateProductReports(input.productReports);
  const openIssues = validateOpenIssues(input.openIssues);
  const gate = evaluateP03PhaseConclusion({
    checklist,
    aggregation,
    evidence,
    cleanup,
    productReports,
    openIssues,
  });

  const candidate: P03AcceptanceReport = {
    reportSchemaVersion: P03_ACCEPTANCE_REPORT_SCHEMA_VERSION,
    reportLayer: P03_REPORT_LAYER,
    runId: input.runId,
    generatedAtUtc: input.generatedAtUtc,
    plan: { ...input.plan },
    git: {
      commit: input.git.commit,
      worktree: input.git.worktree,
      branch: input.git.branch,
      priorBaselines: input.git.priorBaselines.map((baseline) => ({ ...baseline })),
    },
    platform: { ...input.platform },
    tools: { ...input.tools },
    fakeIdentity: { ...P03_FAKE_IDENTITY },
    commands: validateCommands(input.commands).map((command) => ({ ...command })),
    checks: aggregation.checks,
    counts: aggregation.counts,
    conclusion: gate.conclusion,
    evidence,
    cleanup,
    productReports,
    deferred: deferredItems(checklist).map((item) => ({
      id: item.id,
      title: item.title,
      status: (item.deferredStatus ?? 'not_run') as P03DeferredStatus,
    })),
    openIssues,
    knownLimitations: [...(input.knownLimitations ?? [])],
    stateDigests: { ...(input.stateDigests ?? {}) },
  };
  return validateP03AcceptanceReport(candidate, checklist);
}

/* ------------------------------------------------------------------ *
 * 可读摘要（与 report.json 同一结果源）
 * ------------------------------------------------------------------ */

function summaryCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ');
}

function describeCheckStatus(check: P03AggregatedCheck): string {
  if (check.status === 'not_run') {
    return `not_run (${String(check.notRunReason)})`;
  }
  return check.status;
}

function describeAssertions(check: P03AggregatedCheck): string {
  const satisfied = check.assertions.filter((assertion) => assertion.satisfied).length;
  const sideEffect =
    check.sideEffectVerified === null ? 'unknown' : check.sideEffectVerified ? 'ok' : 'failed';
  return `${satisfied}/${check.assertions.length}；副作用 ${sideEffect}`;
}

/** 由报告对象生成简明 Markdown 摘要；不引入报告之外的任何数据源。 */
export function renderP03Summary(report: P03AcceptanceReport): string {
  const lines: string[] = [];
  lines.push(`# P03 阶段验收摘要 — ${report.conclusion === 'pass' ? '通过' : '未通过'}`);
  lines.push('');
  lines.push(
    '- 报告分层：阶段验收报告（本文件，phase-acceptance）与产品 Feature 执行报告（feature-execution-report）分开记录；本摘要不复述产品报告正文。',
  );
  lines.push(`- 运行 ID：\`${report.runId}\``);
  lines.push(`- 生成时间（UTC）：${report.generatedAtUtc}`);
  lines.push(`- 报告 Schema 版本：${report.reportSchemaVersion}`);
  lines.push(
    `- 输入计划：${summaryCell(report.plan.title)}（${summaryCell(report.plan.phaseId)} / ${summaryCell(report.plan.stepId)}，版本 ${summaryCell(report.plan.version)}）`,
  );
  lines.push(`- 范围：${summaryCell(report.plan.scope)}`);
  lines.push(
    `- 校验清单摘要：plan=${report.plan.digestSha256} · checklist=${report.plan.checklistDigestSha256} · 契约 ${summaryCell(report.plan.contractDoc)}`,
  );
  lines.push(
    `- 受测 commit：\`${report.git.commit}\`（工作树 ${report.git.worktree}${report.git.branch !== null ? `，分支 ${summaryCell(report.git.branch)}` : ''}）`,
  );
  for (const baseline of report.git.priorBaselines) {
    lines.push(
      `- 前序基线：${summaryCell(baseline.phase)} @ \`${baseline.tipCommit}\`（${summaryCell(baseline.branch)}）`,
    );
  }
  lines.push(
    `- 平台：${summaryCell(report.platform.system)} ${summaryCell(report.platform.release)} / ${summaryCell(report.platform.arch)}`,
  );
  lines.push(
    `- 工具版本：Node ${summaryCell(report.tools.node)} · npm ${summaryCell(report.tools.npm)} · ${summaryCell(report.tools.git)} · SQLite ${summaryCell(report.tools.sqlite)} · better-sqlite3 ${summaryCell(report.tools.betterSqlite3)} · drizzle-orm ${summaryCell(report.tools.drizzleOrm)}`,
  );
  lines.push(
    `- 执行身份：${summaryCell(report.fakeIdentity.provider)} / ${summaryCell(report.fakeIdentity.model)}（realModel=${String(report.fakeIdentity.realModel)}，network=${summaryCell(report.fakeIdentity.network)}）`,
  );
  lines.push(
    `- 总体结论：**${report.conclusion}**（pass ${report.counts.pass} / fail ${report.counts.fail} / not_run ${report.counts.not_run}，必需检查共 ${report.counts.total} 项）`,
  );
  lines.push('');
  lines.push('## 阶段检查结果（按检查清单分层记录）');
  lines.push('');
  lines.push('| 检查 ID | 层 | FR | T 编号 | 状态 | 真实断言/副作用 | 证据数 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const check of report.checks) {
    lines.push(
      `| ${check.id} | ${summaryCell(check.layer)} | ${summaryCell(check.fr.join(','))} | ${summaryCell(check.acceptanceRefs.join(','))} | ${describeCheckStatus(check)} | ${describeAssertions(check)} | ${check.evidenceRefs.length} |`,
    );
  }
  lines.push('');
  lines.push('## 命令记录');
  lines.push('');
  if (report.commands.length === 0) {
    lines.push('（无）');
  } else {
    lines.push('| 命令 | argv | cwd（逻辑） | 退出码 | 耗时（ms） |');
    lines.push('|---|---|---|---|---|');
    for (const command of report.commands) {
      lines.push(
        `| ${summaryCell(command.label)} | \`${summaryCell(command.argv.join(' '))}\` | \`${command.cwd}\` | ${command.exitCode === null ? '（无）' : command.exitCode}${command.timedOut === true ? '（超时）' : ''} | ${command.durationMs} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 清理与证据导出');
  lines.push('');
  lines.push(
    `- 清理确认：${report.cleanup.confirmed ? '已确认' : '未确认'}；受管进程组：${report.cleanup.processesGone ? '已消失' : '未确认消失'}`,
  );
  lines.push(
    `- cleanup manifest 证据：${report.cleanup.manifestEvidenceRefs.length === 0 ? '（缺失）' : report.cleanup.manifestEvidenceRefs.map((ref) => `\`${ref}\``).join('、')}`,
  );
  for (const note of report.cleanup.notes ?? []) {
    lines.push(`- 清理备注：${summaryCell(note)}`);
  }
  lines.push('');
  lines.push('## 产品 Feature 报告引用');
  lines.push('');
  if (report.productReports.length === 0) {
    lines.push('（缺失：阶段报告必须引用完整产品 Feature 执行报告）');
  } else {
    lines.push('| Feature | 说明 | 命令（逻辑） | 证据 |');
    lines.push('|---|---|---|---|');
    for (const product of report.productReports) {
      lines.push(
        `| ${summaryCell(product.featureId)} | ${summaryCell(product.label)} | \`${summaryCell(product.command)}\` | \`${product.evidenceRef}\` |`,
      );
    }
  }
  lines.push('');
  lines.push('## Deferred（不计入已通过数）');
  lines.push('');
  lines.push('| ID | 标题 | 状态 |');
  lines.push('|---|---|---|');
  for (const entry of report.deferred) {
    lines.push(`| ${entry.id} | ${summaryCell(entry.title)} | ${entry.status} |`);
  }
  lines.push('');
  lines.push('## 遗留问题');
  lines.push('');
  if (report.openIssues.length === 0) {
    lines.push('（无）');
  } else {
    lines.push('| ID | 说明 | 阻塞 |');
    lines.push('|---|---|---|');
    for (const issue of report.openIssues) {
      lines.push(
        `| ${issue.id} | ${summaryCell(issue.summary)} | ${issue.blocking ? '是' : '否'} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 证据清单');
  lines.push('');
  lines.push(
    `共 ${report.evidence.length} 项，均为报告目录内相对路径（${P03_EVIDENCE_DIR_NAME}/ 前缀），在临时资源清理前导出；逐项 identity/category/sha256/sizeBytes 见 report.json。`,
  );
  for (const entry of report.evidence) {
    lines.push(
      `- \`${entry.path}\`（${entry.identity} / ${entry.category} / ${entry.capturedBeforeCleanup ? '清理前' : '清理后'}${entry.checkId !== null ? ` / ${entry.checkId}` : ''}）— ${entry.sizeBytes} bytes`,
    );
  }
  lines.push('');
  lines.push('## 已知限制');
  lines.push('');
  if (report.knownLimitations.length === 0) {
    lines.push('（无）');
  } else {
    for (const limitation of report.knownLimitations) {
      lines.push(`- ${summaryCell(limitation)}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * 报告写入与重验
 * ------------------------------------------------------------------ */

export interface P03EvidenceFileInput {
  /** 报告目录内相对路径（必须以 evidence/ 开头）。 */
  readonly path: string;
  /** 稳定证据身份；缺省为 path。重复身份/重复路径拒绝。 */
  readonly identity?: string;
  readonly category: P03EvidenceCategory;
  /** 证据内容（内存字节）：必须在临时资源清理前采集；文本证据统一脱敏。 */
  readonly content: string | Uint8Array;
  readonly checkId?: string | null;
  /** 是否在清理前导出；SQLite/Git/进程/manifest 证据必须为 true。 */
  readonly capturedBeforeCleanup?: boolean;
}

export interface WriteP03AcceptanceReportOptions {
  readonly reportRoot: string;
  readonly checklist: P03Checklist;
  readonly input: P03PhaseReportInput;
  readonly evidenceFiles?: readonly P03EvidenceFileInput[];
  /** 合成凭据、开发机路径等敏感值；写入前对报告/摘要/证据统一脱敏并复核。 */
  readonly sensitiveValues?: readonly string[];
}

export interface P03ReportVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface P03WrittenReport {
  readonly runDir: string;
  readonly reportPath: string;
  readonly summaryPath: string;
  readonly report: P03AcceptanceReport;
  readonly counts: P03AggregationCounts;
  readonly conclusion: 'pass' | 'fail';
  readonly problems: readonly string[];
  readonly verification: P03ReportVerification;
  /** 0 仅当结论 pass、证据/报告落盘后重验成功且 cleanup 已确认。 */
  readonly exitCode: number;
}

/**
 * 写出一次运行的报告目录：<reportRoot>/<run-id>/{report.json,summary.md,evidence/…}。
 * 全部校验和脱敏在创建目录前完成；run-id 目录已存在即拒绝覆盖；写出后立即重验，
 * 任一项失败返回非零退出码并保留问题，不伪造成功。
 */
export function writeP03AcceptanceReport(
  options: WriteP03AcceptanceReportOptions,
): P03WrittenReport {
  if (!isPlainObject(options)) {
    fail('invalid_input', '写入选项必须是对象');
  }
  assertNonEmptyString(options.reportRoot, 'reportRoot');
  const sensitive = normalizeSensitiveValues(options.sensitiveValues);
  const checklist = options.checklist;
  const runId = assertValidRunId(options.input?.runId);
  const definitions = requiredById(checklist);

  // 1) 证据内容脱敏 + 扫描 + 摘要（在任何文件系统写入前完成）。
  const evidenceInputs = options.evidenceFiles ?? [];
  const identities = new Set<string>();
  const paths = new Set<string>();
  const preparedEvidence: { path: string; bytes: Buffer }[] = [];
  const manifest: P03EvidenceManifestEntry[] = [];
  for (const [index, entry] of evidenceInputs.entries()) {
    const label = `evidenceFiles[${index}]`;
    if (!isPlainObject(entry)) {
      fail('invalid_input', `${label} 必须是对象`);
    }
    const path = assertEvidenceReportPath(entry.path, `${label}.path`);
    if (paths.has(path)) {
      fail('duplicate_evidence', `${label}.path 重复：${path}`);
    }
    paths.add(path);
    const identity = assertNonEmptyString(entry.identity ?? path, `${label}.identity`);
    if (identities.has(identity)) {
      fail('duplicate_evidence', `${label}.identity 重复：${identity}`);
    }
    identities.add(identity);
    const category = entry.category;
    if (!isEvidenceCategory(category)) {
      fail('invalid_input', `${label}.category 非法：${String(entry.category)}`);
    }
    if (entry.checkId !== undefined && entry.checkId !== null) {
      if (typeof entry.checkId !== 'string' || !definitions.has(entry.checkId)) {
        fail('unknown_check', `${label}.checkId 未知：${String(entry.checkId)}`);
      }
    }
    if (
      entry.capturedBeforeCleanup !== undefined &&
      typeof entry.capturedBeforeCleanup !== 'boolean'
    ) {
      fail('invalid_input', `${label}.capturedBeforeCleanup 必须是布尔值`);
    }
    if (typeof entry.content !== 'string' && !(entry.content instanceof Uint8Array)) {
      fail('invalid_input', `${label}.content 必须是字符串或字节`);
    }
    let bytes: Buffer;
    if (typeof entry.content === 'string') {
      const redacted = redactSensitiveText(entry.content, sensitive);
      assertNoSensitiveText(redacted, sensitive, `${label}.content`);
      assertNoCredentialShapesInText(redacted, `${label}.content`);
      assertNoDeveloperPathsInText(redacted, `${label}.content`);
      bytes = Buffer.from(redacted, 'utf-8');
    } else {
      bytes = Buffer.from(entry.content);
      for (const value of sensitive) {
        if (bytes.includes(Buffer.from(value, 'utf-8'))) {
          fail(
            'secret_leak',
            `${label}.content 为字节证据且包含敏感值；请先脱敏或以文本提供`,
            sha256Hex(value).slice(0, 12),
          );
        }
      }
      const text = bytes.toString('utf-8');
      assertNoCredentialShapesInText(text, `${label}.content`);
      assertNoDeveloperPathsInText(text, `${label}.content`);
    }
    preparedEvidence.push({ path, bytes });
    manifest.push({
      identity,
      category,
      path,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.length,
      checkId: entry.checkId ?? null,
      capturedBeforeCleanup: entry.capturedBeforeCleanup ?? true,
    });
  }

  // 2) 装配并全量校验报告（聚合 + 证据交叉引用 + 清理/产品报告门禁）。
  const report = buildP03AcceptanceReport(checklist, options.input, manifest);
  const byPath = new Map(manifest.map((entry) => [entry.path, entry]));
  const aggregation = aggregationFromReportChecks(
    checklist,
    report.checks as unknown as readonly Record<string, unknown>[],
  );
  const gate = evaluateP03PhaseConclusion({
    checklist,
    aggregation,
    evidence: manifest,
    cleanup: report.cleanup,
    productReports: report.productReports,
    openIssues: report.openIssues,
  });
  if (gate.conclusion !== report.conclusion) {
    fail('invalid_report', '阶段结论在装配与门禁复算之间不一致');
  }

  // 3) 序列化 + 脱敏复核 + 凭据/开发机路径扫描。
  const reportJson = redactSensitiveText(`${JSON.stringify(report, null, 2)}\n`, sensitive);
  const summary = redactSensitiveText(renderP03Summary(report), sensitive);
  assertNoSensitiveText(reportJson, sensitive, P03_REPORT_FILE_NAME);
  assertNoSensitiveText(summary, sensitive, P03_SUMMARY_FILE_NAME);
  assertNoCredentialShapesInText(reportJson, P03_REPORT_FILE_NAME);
  assertNoCredentialShapesInText(summary, P03_SUMMARY_FILE_NAME);
  assertNoDeveloperPathsInText(reportJson, P03_REPORT_FILE_NAME);
  assertNoDeveloperPathsInText(summary, P03_SUMMARY_FILE_NAME);

  // 4) 写出。run-id 目录已存在即拒绝覆盖。
  const runDir = resolve(options.reportRoot, runId);
  if (existsSync(runDir)) {
    fail('run_id_exists', `run-id 目录已存在，拒绝覆盖：${runId}`, runId);
  }
  let created = false;
  try {
    mkdirSync(runDir, { recursive: true });
    created = true;
    for (const entry of preparedEvidence) {
      const absolute = join(runDir, ...entry.path.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, entry.bytes);
    }
    writeFileSync(join(runDir, P03_REPORT_FILE_NAME), reportJson, 'utf-8');
    writeFileSync(join(runDir, P03_SUMMARY_FILE_NAME), summary, 'utf-8');
  } catch (error) {
    if (created) {
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        // 尽力回收半成品目录；原始错误优先。
      }
    }
    if (error instanceof P03ReportError) {
      throw error;
    }
    fail('report_write_failed', `报告写入失败：${(error as Error).message}`, runId);
  }

  // 5) 落盘后整目录重验：Schema、计数/结论、证据 size/sha256 与扫描。
  const verification = verifyP03ReportDirectory(runDir, checklist);
  const exitCode = computeP03PhaseExitCode({
    conclusion: report.conclusion,
    evidenceOk: verification.ok,
    reportWritten: true,
    cleanupConfirmed: report.cleanup.confirmed,
  });

  return {
    runDir,
    reportPath: join(runDir, P03_REPORT_FILE_NAME),
    summaryPath: join(runDir, P03_SUMMARY_FILE_NAME),
    report,
    counts: report.counts,
    conclusion: report.conclusion,
    problems: gate.problems,
    verification,
    exitCode,
  };
}

/**
 * 重新核验已写出的报告目录：report.json 可解析且通过严格 Schema 校验、
 * summary.md 在位、run-id 与目录一致、报告/摘要无凭据形状或开发机路径、
 * 证据逐项存在且 size/sha256 匹配。缺失/损坏/被篡改都计入问题。
 */
export function verifyP03ReportDirectory(
  runDir: string,
  checklist: P03Checklist = loadP03Checklist(),
): P03ReportVerification {
  const problems: string[] = [];
  const reportPath = join(runDir, P03_REPORT_FILE_NAME);
  if (!existsSync(reportPath)) {
    return { ok: false, problems: [`缺少 ${P03_REPORT_FILE_NAME}`] };
  }
  const reportText = readFileSync(reportPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportText);
  } catch (error) {
    return {
      ok: false,
      problems: [`${P03_REPORT_FILE_NAME} 无法解析：${(error as Error).message}`],
    };
  }
  let report: P03AcceptanceReport;
  try {
    report = validateP03AcceptanceReport(parsed, checklist);
  } catch (error) {
    if (error instanceof P03ReportError) {
      return { ok: false, problems: [`报告 Schema 非法：${error.message}`] };
    }
    throw error;
  }
  if (report.runId !== basename(resolve(runDir))) {
    problems.push(`报告 run-id 与目录名不一致：${report.runId}`);
  }
  for (const hit of scanTextForCredentialShapes(reportText)) {
    problems.push(`报告含凭据形状：${hit}`);
  }
  for (const hit of scanTextForDeveloperPaths(reportText)) {
    problems.push(`报告含开发机绝对路径：${hit}`);
  }

  const summaryPath = join(runDir, P03_SUMMARY_FILE_NAME);
  if (!existsSync(summaryPath)) {
    problems.push(`缺少 ${P03_SUMMARY_FILE_NAME}`);
  } else {
    const summaryText = readFileSync(summaryPath, 'utf-8');
    for (const hit of scanTextForCredentialShapes(summaryText)) {
      problems.push(`摘要含凭据形状：${hit}`);
    }
    for (const hit of scanTextForDeveloperPaths(summaryText)) {
      problems.push(`摘要含开发机绝对路径：${hit}`);
    }
  }

  for (const entry of report.evidence) {
    const absolute = join(runDir, ...entry.path.split('/'));
    if (!existsSync(absolute)) {
      problems.push(`证据缺失：${entry.path}`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch (error) {
      problems.push(`证据不可读：${entry.path}（${(error as Error).message}）`);
      continue;
    }
    if (bytes.length !== entry.sizeBytes) {
      problems.push(
        `证据损坏（size 不符）：${entry.path}（清单 ${entry.sizeBytes}，实际 ${bytes.length}）`,
      );
      continue;
    }
    if (sha256Hex(bytes) !== entry.sha256) {
      problems.push(`证据损坏（sha256 不符）：${entry.path}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
