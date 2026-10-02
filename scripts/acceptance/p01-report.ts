/**
 * P01-4 / F-007 版本化 P01 阶段验收报告、证据清单与严格结果聚合器
 * （开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口）。
 *
 * 依据 `docs/p01-4-acceptance-contract.md`（F-001）冻结的约定实现：
 * - 14 个必需检查 ID 在此以机器可读形式固定（`P01_REQUIRED_CHECKS`，顺序即报告与聚合的
 *   固定顺序）；未知或重复的检查 ID 一律拒绝，不得聚合为通过；
 * - 每个检查结果只有 pass / fail / not_run 三态；未提交结果、启动失败、超时与被跳过的
 *   必需项全部归类为 not_run（携带 notRunReason 分类），空结果集不得聚合为通过；
 * - 预期负例（expectedNegative，如 P01-FR1-ROLLBACK / P01-FR2-ROLLBACK /
 *   P01-FR2-CONFIG 拒绝分支 / P01-FR2-ARTIFACT-MISSING）只有在错误断言与副作用断言
 *   同时成立时才计为 pass，否则降级为 fail；
 * - 报告记录输入计划版本/摘要、范围、受测 commit 与工作树状态、前序基线、UTC 时间、
 *   OS/架构、实际工具版本、Schema 版本、命令 argv/逻辑 cwd/退出码/耗时、逐项结果、
 *   代码与持久状态摘要、证据路径/hash/size 及已知限制；业务身份只用检查 ID，
 *   不使用展示名称；
 * - JSON 报告（report.json）与可读摘要（summary.md）由同一结果源生成；每次运行写入
 *   独立 <reportRoot>/<run-id>/ 目录，已存在的 run-id 拒绝覆盖；证据引用为报告内
 *   相对路径（evidence/ 前缀），临时资源路径用逻辑位置（<repo> 等形式）表达；
 * - 不导出完整环境变量、认证配置或原始秘密：写入前对报告 JSON、摘要与证据附件统一
 *   按敏感值脱敏并复核，仍含敏感值即失败（secret_leak），不允许只脱敏摘要却泄漏附件；
 * - 阶段外能力（模型 Live、强沙箱、其他平台）以 P01-OOS-* 记录为 not_run/unsupported，
 *   不计入必需项通过数；
 * - 任一必需 fail 或 not_run、缺失/损坏证据、报告写入失败都使阶段退出码非零
 *   （computeP01PhaseExitCode / verifyP01ReportDirectory）。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接运行；
 * 不调用模型，不联网，不修改受检仓库中的任何文件（只写 reportRoot 下的运行目录）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/* ------------------------------------------------------------------ *
 * 常量与错误
 * ------------------------------------------------------------------ */

export const P01_ACCEPTANCE_REPORT_SCHEMA_VERSION = 1;
export const P01_REPORT_FILE_NAME = 'report.json';
export const P01_SUMMARY_FILE_NAME = 'summary.md';
export const P01_EVIDENCE_DIR_NAME = 'evidence';

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUN_ID_MAX_LENGTH = 128;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const LOGICAL_LOCATION_PATTERN = /^<[A-Za-z0-9][A-Za-z0-9._-]*>(\/[A-Za-z0-9._-]+)*$/;
const OUT_OF_SCOPE_ID_PATTERN = /^P01-OOS-[A-Z0-9][A-Z0-9-]*$/;

export type P01ReportErrorKind =
  | 'invalid_input'
  | 'invalid_run_id'
  | 'run_id_exists'
  | 'unknown_check'
  | 'duplicate_check'
  | 'invalid_result'
  | 'invalid_report'
  | 'evidence_missing'
  | 'evidence_corrupt'
  | 'unsafe_path'
  | 'secret_leak'
  | 'report_write_failed';

export class P01ReportError extends Error {
  readonly kind: P01ReportErrorKind;
  readonly detail?: string;

  constructor(kind: P01ReportErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'P01ReportError';
    this.kind = kind;
    this.detail = detail;
  }
}

function fail(kind: P01ReportErrorKind, message: string, detail?: string): never {
  throw new P01ReportError(kind, message, detail);
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/* ------------------------------------------------------------------ *
 * 冻结的必需检查清单（契约 §2.1；顺序固定）
 * ------------------------------------------------------------------ */

export interface P01RequiredCheckDefinition {
  readonly id: string;
  readonly group: 'ENG' | 'FR1' | 'FR2' | 'PHASE';
  /** 承接的 FR / 阶段分支（契约 §2.1 第二列语义）。 */
  readonly frBranch: string;
  readonly summary: string;
  /** 实际测试 / 命令入口（契约 §2.1；F-008/F-009 入口为约定路径）。 */
  readonly testEntry: string;
  /**
   * 预期负例：pass 必须同时携带 errorAssertion 与 sideEffectAssertion，
   * 否则聚合器降级为 fail（契约 §2.4）。
   */
  readonly expectedNegative: boolean;
}

export const P01_REQUIRED_CHECKS: readonly P01RequiredCheckDefinition[] = [
  {
    id: 'P01-ENG-VERIFY',
    group: 'ENG',
    frBranch: '工程',
    summary: 'npm run verify（test/typecheck/build）退出 0',
    testEntry: 'npm run verify',
    expectedNegative: false,
  },
  {
    id: 'P01-FR1-NORMAL',
    group: 'FR1',
    frBranch: 'FR-1 正常',
    summary: '临时数据根注册真实 Git 仓库、写全局/项目配置、发布固定正文制品',
    testEntry: 'test/p01-4-persistence-closed-loop.test.ts',
    expectedNegative: false,
  },
  {
    id: 'P01-FR1-REOPEN',
    group: 'FR1',
    frBranch: 'FR-1 重开',
    summary: '关闭全部连接后以新装配实例打开同一数据根，逐字段一致',
    testEntry: 'test/p01-4-persistence-closed-loop.test.ts',
    expectedNegative: false,
  },
  {
    id: 'P01-FR1-ROLLBACK',
    group: 'FR1',
    frBranch: 'FR-1 回滚',
    summary: '组合创建首个写入后注入确定性异常，项目及绑定/初始配置全部不存在',
    testEntry: 'test/p01-4-sqlite-rollback-and-cas.test.ts',
    expectedNegative: true,
  },
  {
    id: 'P01-FR2-CONFIG',
    group: 'FR2',
    frBranch: 'FR-2 正常/拒绝',
    summary: '完整策略整体覆盖、当前值与来源重开读取、未知版本/runtime/不完整策略拒绝、凭据仅存引用',
    testEntry: 'test/p01-4-config-and-tags.test.ts',
    expectedNegative: true,
  },
  {
    id: 'P01-FR2-ROLLBACK',
    group: 'FR2',
    frBranch: 'FR-2 回滚',
    summary: '配置更新与脱敏变更记录提交之间注入失败，payload/revision/记录全部回滚',
    testEntry: 'test/p01-4-sqlite-rollback-and-cas.test.ts',
    expectedNegative: true,
  },
  {
    id: 'P01-FR2-CAS',
    group: 'FR2',
    frBranch: 'FR-2 CAS',
    summary: '真实独立进程同一旧 revision 竞争更新恰一成功一 conflict，revision 仅增一次',
    testEntry: 'test/p01-4-sqlite-rollback-and-cas.test.ts',
    expectedNegative: false,
  },
  {
    id: 'P01-FR2-TAGS',
    group: 'FR2',
    frBranch: 'T32 项目标签',
    summary: '标签规范化、非法数组拒绝、任一/全部筛选及去重计数',
    testEntry: 'test/p01-4-config-and-tags.test.ts',
    expectedNegative: false,
  },
  {
    id: 'P01-FR2-ARTIFACT-MISSING',
    group: 'FR2',
    frBranch: 'FR-2 制品缺失',
    summary: '删除正文后读取/核对报告 missing/corrupt，不返回有效引用或空正文',
    testEntry: 'test/p01-4-artifact-negative.test.ts',
    expectedNegative: true,
  },
  {
    id: 'P01-FR2-ARTIFACT-RECOVERY',
    group: 'FR2',
    frBranch: 'FR-2 制品恢复',
    summary: '发布中断后重开核对；pending 仅 hash/size 匹配补 ready；孤儿保留/安全隔离',
    testEntry: 'test/p01-4-artifact-negative.test.ts',
    expectedNegative: false,
  },
  {
    id: 'P01-PHASE-FIXTURE',
    group: 'PHASE',
    frBranch: '夹具失败',
    summary: '夹具准备失败明确 fail/not_run，阶段非零，且保留已取得证据',
    testEntry: 'test/p01-4-acceptance-controller.test.ts',
    expectedNegative: false,
  },
  {
    id: 'P01-PHASE-NOT-RUN',
    group: 'PHASE',
    frBranch: '必需检查未运行',
    summary: '未提交结果/启动失败/超时/被跳过的必需项标 not_run，不得聚合为通过',
    testEntry: 'test/p01-4-report-aggregation.test.ts',
    expectedNegative: false,
  },
  {
    id: 'P01-ENG-BUILD-SMOKE',
    group: 'ENG',
    frBranch: '构建产物',
    summary: '非源码 cwd 从 dist 装载公共入口与迁移执行闭环，无个人绝对路径/Nezha 依赖',
    testEntry: 'test/p01-4-build-smoke.test.ts',
    expectedNegative: false,
  },
  {
    id: 'P01-PHASE-REPORT',
    group: 'PHASE',
    frBranch: '报告完整性',
    summary: '版本化报告 Schema、逐项结果、证据 path/hash/size、总体结论可验证',
    testEntry: 'test/p01-4-report-aggregation.test.ts',
    expectedNegative: false,
  },
];

export const P01_REQUIRED_CHECK_IDS: readonly string[] = P01_REQUIRED_CHECKS.map(
  (definition) => definition.id,
);

const REQUIRED_BY_ID: ReadonlyMap<string, P01RequiredCheckDefinition> = new Map(
  P01_REQUIRED_CHECKS.map((definition) => [definition.id, definition]),
);

/* ------------------------------------------------------------------ *
 * 检查结果与聚合
 * ------------------------------------------------------------------ */

export type P01CheckStatus = 'pass' | 'fail' | 'not_run';

/** not_run 的明确分类：未提交结果 / 启动失败 / 超时 / 被跳过（契约 §2.4）。 */
export type P01NotRunReason = 'missing_result' | 'startup_failure' | 'timeout' | 'skipped';

const CHECK_STATUSES: readonly P01CheckStatus[] = ['pass', 'fail', 'not_run'];
const NOT_RUN_REASONS: readonly P01NotRunReason[] = [
  'missing_result',
  'startup_failure',
  'timeout',
  'skipped',
];

/** 调用方提交的单项检查结果（聚合器输入）。 */
export interface P01CheckResultInput {
  readonly checkId: string;
  readonly status: P01CheckStatus;
  /** status=not_run 时必填的明确分类；其他状态不得携带。 */
  readonly notRunReason?: P01NotRunReason;
  /** 预期负例：错误断言成立。 */
  readonly errorAssertion?: boolean;
  /** 预期负例：副作用断言成立（零半条记录/索引不变等）。 */
  readonly sideEffectAssertion?: boolean;
  readonly durationMs?: number;
  readonly detail?: string;
  /** 报告内相对证据路径（必须以 evidence/ 开头）。 */
  readonly evidenceRefs?: readonly string[];
}

export interface P01AggregatedCheck {
  readonly id: string;
  readonly group: string;
  readonly frBranch: string;
  readonly summary: string;
  readonly testEntry: string;
  readonly expectedNegative: boolean;
  readonly status: P01CheckStatus;
  readonly notRunReason: P01NotRunReason | null;
  readonly errorAssertion: boolean | null;
  readonly sideEffectAssertion: boolean | null;
  readonly durationMs: number | null;
  readonly detail: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface P01AggregationCounts {
  readonly pass: number;
  readonly fail: number;
  readonly not_run: number;
  readonly total: number;
}

export interface P01Aggregation {
  readonly checks: readonly P01AggregatedCheck[];
  readonly counts: P01AggregationCounts;
  /** pass 仅当全部必需检查均为 pass；空结果集聚合为 fail。 */
  readonly conclusion: 'pass' | 'fail';
  /** 人类可读的未通过原因清单（fail/not_run/降级）。 */
  readonly problems: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOptionalBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'boolean') {
    fail('invalid_result', `${label} 必须是布尔值`);
  }
  return value;
}

function assertOptionalDuration(value: unknown, label: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('invalid_result', `${label} 必须是非负有限毫秒数`);
  }
  return value;
}

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

/** 证据路径必须是报告目录内 evidence/ 下的相对路径。 */
export function assertEvidenceReportPath(relativePath: unknown, label: string): string {
  const normalized = assertSafeReportRelativePath(relativePath, label);
  const segments = normalized.split('/');
  if (segments[0] !== P01_EVIDENCE_DIR_NAME || segments.length < 2) {
    fail('unsafe_path', `${label} 必须位于 ${P01_EVIDENCE_DIR_NAME}/ 之内：${normalized}`);
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

function validateEvidenceRefs(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail('invalid_result', `${label} 必须是字符串数组`);
  }
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const entry of value as unknown[]) {
    const normalized = assertEvidenceReportPath(entry, label);
    if (seen.has(normalized)) {
      fail('invalid_result', `${label} 存在重复证据引用：${normalized}`);
    }
    seen.add(normalized);
    refs.push(normalized);
  }
  return refs;
}

/**
 * 严格聚合提交的检查结果：
 * - 未知 / 重复检查 ID 直接拒绝（unknown_check / duplicate_check）；
 * - 未提交的必需检查记 not_run（missing_result）；
 * - not_run 必须携带明确分类；pass/fail 不得携带 notRunReason；
 * - 预期负例缺少错误/副作用双断言的 pass 降级为 fail；
 * - 结论 pass 当且仅当全部必需检查均为 pass。
 */
export function aggregateP01CheckResults(
  results: readonly P01CheckResultInput[],
): P01Aggregation {
  if (!Array.isArray(results)) {
    fail('invalid_input', '检查结果必须是数组');
  }
  const byId = new Map<string, P01AggregatedCheck>();
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
    const definition = REQUIRED_BY_ID.get(checkId);
    if (definition === undefined) {
      fail('unknown_check', `未知检查 ID：${checkId}`, checkId);
    }
    if (byId.has(checkId)) {
      fail('duplicate_check', `重复提交的检查 ID：${checkId}`, checkId);
    }
    if (
      typeof entry.status !== 'string' ||
      !CHECK_STATUSES.includes(entry.status as P01CheckStatus)
    ) {
      fail('invalid_result', `检查 ${checkId} 的 status 非法：${String(entry.status)}`);
    }
    const status = entry.status as P01CheckStatus;
    const notRunReasonRaw = entry.notRunReason;
    let notRunReason: P01NotRunReason | null = null;
    if (status === 'not_run') {
      if (
        typeof notRunReasonRaw !== 'string' ||
        !NOT_RUN_REASONS.includes(notRunReasonRaw as P01NotRunReason)
      ) {
        fail(
          'invalid_result',
          `检查 ${checkId} 为 not_run 时必须携带明确分类（${NOT_RUN_REASONS.join('/') }）`,
        );
      }
      notRunReason = notRunReasonRaw as P01NotRunReason;
    } else if (notRunReasonRaw !== undefined && notRunReasonRaw !== null) {
      fail('invalid_result', `检查 ${checkId} 非 not_run 状态不得携带 notRunReason`);
    }
    const detail =
      entry.detail === undefined || entry.detail === null ? null : entry.detail;
    if (detail !== null && typeof detail !== 'string') {
      fail('invalid_result', `检查 ${checkId} 的 detail 必须是字符串`);
    }
    byId.set(checkId, {
      id: definition.id,
      group: definition.group,
      frBranch: definition.frBranch,
      summary: definition.summary,
      testEntry: definition.testEntry,
      expectedNegative: definition.expectedNegative,
      status,
      notRunReason,
      errorAssertion: assertOptionalBoolean(entry.errorAssertion, `检查 ${checkId} 的 errorAssertion`),
      sideEffectAssertion: assertOptionalBoolean(
        entry.sideEffectAssertion,
        `检查 ${checkId} 的 sideEffectAssertion`,
      ),
      durationMs: assertOptionalDuration(entry.durationMs, `检查 ${checkId} 的 durationMs`),
      detail: detail as string | null,
      evidenceRefs: validateEvidenceRefs(entry.evidenceRefs, `检查 ${checkId} 的 evidenceRefs`),
    });
  }

  for (const definition of P01_REQUIRED_CHECKS) {
    if (!byId.has(definition.id)) {
      byId.set(definition.id, {
        id: definition.id,
        group: definition.group,
        frBranch: definition.frBranch,
        summary: definition.summary,
        testEntry: definition.testEntry,
        expectedNegative: definition.expectedNegative,
        status: 'not_run',
        notRunReason: 'missing_result',
        errorAssertion: null,
        sideEffectAssertion: null,
        durationMs: null,
        detail: null,
        evidenceRefs: [],
      });
      problems.push(`${definition.id}: 未提交结果（not_run/missing_result）`);
    }
  }

  const checks: P01AggregatedCheck[] = [];
  for (const definition of P01_REQUIRED_CHECKS) {
    const entry = byId.get(definition.id) as P01AggregatedCheck;
    if (
      entry.expectedNegative &&
      entry.status === 'pass' &&
      !(entry.errorAssertion === true && entry.sideEffectAssertion === true)
    ) {
      const note = '预期负例缺少错误断言与副作用断言（须同时成立），不计为通过';
      const downgraded: P01AggregatedCheck = {
        ...entry,
        status: 'fail',
        detail: entry.detail === null ? note : `${entry.detail}；${note}`,
      };
      checks.push(downgraded);
      problems.push(`${definition.id}: ${note}`);
      continue;
    }
    checks.push(entry);
    if (entry.status === 'fail') {
      problems.push(`${definition.id}: fail${entry.detail !== null ? ` — ${entry.detail}` : ''}`);
    } else if (entry.status === 'not_run' && entry.notRunReason !== 'missing_result') {
      problems.push(`${definition.id}: not_run/${String(entry.notRunReason)}`);
    }
  }

  const counts: P01AggregationCounts = {
    pass: checks.filter((check) => check.status === 'pass').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    not_run: checks.filter((check) => check.status === 'not_run').length,
    total: checks.length,
  };
  const conclusion: 'pass' | 'fail' = counts.pass === counts.total ? 'pass' : 'fail';
  return { checks, counts, conclusion, problems };
}

/**
 * 阶段退出码：任一必需 fail/not_run（conclusion=fail）、缺失/损坏证据或报告写入失败
 * 都为非零；只有全部通过且证据完好、报告已写出才返回 0。
 */
export function computeP01PhaseExitCode(input: {
  readonly conclusion: 'pass' | 'fail';
  readonly evidenceOk: boolean;
  readonly reportWritten: boolean;
}): number {
  return input.conclusion === 'pass' && input.evidenceOk && input.reportWritten ? 0 : 1;
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

/**
 * 由 UTC 时钟与随机后缀派生 run-id：<YYYYMMDDThhmmssZ>-<8 hex>。
 * 后缀可注入（测试确定性）；缺省使用加密随机 4 字节。
 */
export function generateP01RunId(nowUtc: Date, randomSuffixHex?: string): string {
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
 * 脱敏
 * ------------------------------------------------------------------ */

function normalizeSensitiveValues(sensitiveValues: readonly string[] | undefined): readonly string[] {
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

/** 文本脱敏：每个敏感值的所有出现都替换为带内容摘要的占位符（不回显秘密本身）。 */
export function redactSensitiveText(
  text: string,
  sensitiveValues: readonly string[],
): string {
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

/* ------------------------------------------------------------------ *
 * 报告输入与报告结构（Schema v1）
 * ------------------------------------------------------------------ */

export interface P01CommandRecord {
  readonly label: string;
  /** 显式 argv（不经 Shell 拼接）。 */
  readonly argv: readonly string[];
  /** 逻辑 cwd（<repo> 等形式），不记录个人绝对路径。 */
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut?: boolean;
}

export interface P01OutOfScopeEntry {
  /** 必须 P01-OOS-* 前缀，不得与必需检查 ID 冲突。 */
  readonly id: string;
  readonly capability: string;
  readonly status: 'not_run' | 'unsupported';
  readonly note: string;
}

export interface P01EvidenceManifestEntry {
  /** 报告目录内相对路径（evidence/ 前缀）。 */
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** 关联的必需检查 ID（可为空，如全局快照）。 */
  readonly checkId: string | null;
}

export interface P01AcceptanceReportInput {
  readonly runId: string;
  /** ISO 8601 UTC（…Z）。 */
  readonly generatedAtUtc: string;
  readonly plan: {
    readonly phaseId: string;
    readonly title: string;
    readonly scope: string;
    /** 输入计划（PRD/契约）版本。 */
    readonly version: string;
    /** 输入计划内容摘要（SHA-256，64 位小写十六进制）。 */
    readonly digestSha256: string;
  };
  readonly git: {
    /** 受测 commit（40 位小写十六进制）。 */
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
  readonly schemaVersions: {
    readonly settingsSchema: number;
    readonly settingsExportFormat: number;
    readonly sqliteMigrations: readonly number[];
  };
  readonly commands: readonly P01CommandRecord[];
  readonly results: readonly P01CheckResultInput[];
  readonly stateDigests?: {
    readonly businessInputSha256?: string;
    readonly codeSha256?: string;
    readonly persistentStateSha256?: string;
  };
  readonly outOfScope?: readonly P01OutOfScopeEntry[];
  readonly knownLimitations?: readonly string[];
}

export interface P01AcceptanceReport {
  readonly reportSchemaVersion: number;
  readonly runId: string;
  readonly generatedAtUtc: string;
  readonly plan: P01AcceptanceReportInput['plan'];
  readonly git: P01AcceptanceReportInput['git'];
  readonly platform: P01AcceptanceReportInput['platform'];
  readonly tools: P01AcceptanceReportInput['tools'];
  readonly schemaVersions: P01AcceptanceReportInput['schemaVersions'];
  readonly commands: readonly P01CommandRecord[];
  readonly checks: readonly P01AggregatedCheck[];
  readonly counts: P01AggregationCounts;
  readonly conclusion: 'pass' | 'fail';
  readonly evidence: readonly P01EvidenceManifestEntry[];
  readonly stateDigests: NonNullable<P01AcceptanceReportInput['stateDigests']>;
  readonly outOfScope: readonly P01OutOfScopeEntry[];
  readonly knownLimitations: readonly string[];
}

/* ---------------------------- 输入校验 ---------------------------- */

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_input', `${label} 必须是非空字符串`);
  }
  return value;
}

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

function validateCommands(value: unknown): readonly P01CommandRecord[] {
  if (!Array.isArray(value)) {
    fail('invalid_input', 'commands 必须是数组');
  }
  return (value as unknown[]).map((raw, index) => {
    const label = `commands[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_input', `${label} 必须是对象`);
    }
    const entry = raw as Record<string, unknown>;
    if (!Array.isArray(entry.argv) || entry.argv.length === 0) {
      fail('invalid_input', `${label}.argv 必须是非空字符串数组`);
    }
    for (const arg of entry.argv as unknown[]) {
      if (typeof arg !== 'string' || arg.length === 0) {
        fail('invalid_input', `${label}.argv 只允许非空字符串`);
      }
    }
    if (entry.exitCode !== null && (typeof entry.exitCode !== 'number' || !Number.isInteger(entry.exitCode))) {
      fail('invalid_input', `${label}.exitCode 必须是整数或 null`);
    }
    const duration = assertOptionalDuration(entry.durationMs, `${label}.durationMs`);
    if (duration === null) {
      fail('invalid_input', `${label}.durationMs 必填`);
    }
    if (entry.timedOut !== undefined && typeof entry.timedOut !== 'boolean') {
      fail('invalid_input', `${label}.timedOut 必须是布尔值`);
    }
    return {
      label: assertNonEmptyString(entry.label, `${label}.label`),
      argv: [...(entry.argv as readonly string[])],
      cwd: assertLogicalLocation(entry.cwd, `${label}.cwd`),
      exitCode: entry.exitCode as number | null,
      durationMs: duration,
      ...(entry.timedOut !== undefined ? { timedOut: entry.timedOut as boolean } : {}),
    };
  });
}

function validateOutOfScope(value: unknown): readonly P01OutOfScopeEntry[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail('invalid_input', 'outOfScope 必须是数组');
  }
  const seen = new Set<string>();
  return (value as unknown[]).map((raw, index) => {
    const label = `outOfScope[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_input', `${label} 必须是对象`);
    }
    const entry = raw as Record<string, unknown>;
    const id = assertNonEmptyString(entry.id, `${label}.id`);
    if (!OUT_OF_SCOPE_ID_PATTERN.test(id)) {
      fail('invalid_input', `${label}.id 必须匹配 P01-OOS-*：${id}`);
    }
    if (REQUIRED_BY_ID.has(id)) {
      fail('invalid_input', `${label}.id 不得与必需检查 ID 冲突：${id}`);
    }
    if (seen.has(id)) {
      fail('invalid_input', `${label}.id 重复：${id}`);
    }
    seen.add(id);
    if (entry.status !== 'not_run' && entry.status !== 'unsupported') {
      fail('invalid_input', `${label}.status 必须是 not_run 或 unsupported`);
    }
    return {
      id,
      capability: assertNonEmptyString(entry.capability, `${label}.capability`),
      status: entry.status,
      note: assertNonEmptyString(entry.note, `${label}.note`),
    };
  });
}

function validateReportInput(input: P01AcceptanceReportInput): void {
  if (!isPlainObject(input)) {
    fail('invalid_input', '报告输入必须是对象');
  }
  assertValidRunId(input.runId);
  assertUtcIso(input.generatedAtUtc, 'generatedAtUtc');

  if (!isPlainObject(input.plan)) {
    fail('invalid_input', 'plan 必须是对象');
  }
  assertNonEmptyString(input.plan.phaseId, 'plan.phaseId');
  assertNonEmptyString(input.plan.title, 'plan.title');
  assertNonEmptyString(input.plan.scope, 'plan.scope');
  assertNonEmptyString(input.plan.version, 'plan.version');
  assertSha256Digest(input.plan.digestSha256, 'plan.digestSha256');

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

  if (!isPlainObject(input.schemaVersions)) {
    fail('invalid_input', 'schemaVersions 必须是对象');
  }
  for (const key of ['settingsSchema', 'settingsExportFormat'] as const) {
    const value = input.schemaVersions[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      fail('invalid_input', `schemaVersions.${key} 必须是正整数`);
    }
  }
  const migrations = input.schemaVersions.sqliteMigrations;
  if (!Array.isArray(migrations) || migrations.length === 0) {
    fail('invalid_input', 'schemaVersions.sqliteMigrations 必须是非空数组');
  }
  migrations.forEach((version, index) => {
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      fail('invalid_input', `schemaVersions.sqliteMigrations[${index}] 必须是正整数`);
    }
    if (index > 0 && (version as number) <= (migrations[index - 1] as number)) {
      fail('invalid_input', 'schemaVersions.sqliteMigrations 必须严格递增');
    }
  });

  validateCommands(input.commands);

  if (input.stateDigests !== undefined) {
    if (!isPlainObject(input.stateDigests)) {
      fail('invalid_input', 'stateDigests 必须是对象');
    }
    for (const key of ['businessInputSha256', 'codeSha256', 'persistentStateSha256'] as const) {
      const value = input.stateDigests[key];
      if (value !== undefined) {
        assertSha256Digest(value, `stateDigests.${key}`);
      }
    }
  }

  validateOutOfScope(input.outOfScope);

  if (input.knownLimitations !== undefined) {
    if (!Array.isArray(input.knownLimitations)) {
      fail('invalid_input', 'knownLimitations 必须是字符串数组');
    }
    for (const [index, item] of input.knownLimitations.entries()) {
      assertNonEmptyString(item, `knownLimitations[${index}]`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 报告装配与严格 Schema 校验
 * ------------------------------------------------------------------ */

const REPORT_TOP_LEVEL_KEYS = [
  'reportSchemaVersion',
  'runId',
  'generatedAtUtc',
  'plan',
  'git',
  'platform',
  'tools',
  'schemaVersions',
  'commands',
  'checks',
  'counts',
  'conclusion',
  'evidence',
  'stateDigests',
  'outOfScope',
  'knownLimitations',
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

/**
 * 严格校验报告对象（Schema v1）：版本、字段、未知字段、检查 ID 集合与顺序、
 * 状态/分类一致性、计数与结论重算、证据清单形态与交叉引用。
 * 非法报告一律抛 invalid_report。
 */
export function validateP01AcceptanceReport(value: unknown): P01AcceptanceReport {
  if (!isPlainObject(value)) {
    fail('invalid_report', '报告必须是对象');
  }
  const report = value as Record<string, unknown>;
  assertAllowedKeys(report, REPORT_TOP_LEVEL_KEYS, '报告');

  if (report.reportSchemaVersion !== P01_ACCEPTANCE_REPORT_SCHEMA_VERSION) {
    fail(
      'invalid_report',
      `reportSchemaVersion 必须是 ${P01_ACCEPTANCE_REPORT_SCHEMA_VERSION}，收到：${String(report.reportSchemaVersion)}`,
    );
  }
  assertValidRunId(report.runId);
  assertUtcIso(report.generatedAtUtc, 'generatedAtUtc');

  if (!Array.isArray(report.checks)) {
    fail('invalid_report', 'checks 必须是数组');
  }
  const checks = report.checks as unknown[];
  if (checks.length !== P01_REQUIRED_CHECKS.length) {
    fail('invalid_report', `checks 必须恰好 ${P01_REQUIRED_CHECKS.length} 项`);
  }
  const seenEvidenceRefs: string[] = [];
  checks.forEach((raw, index) => {
    const label = `checks[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_report', `${label} 必须是对象`);
    }
    const entry = raw as Record<string, unknown>;
    assertAllowedKeys(
      entry,
      [
        'id',
        'group',
        'frBranch',
        'summary',
        'testEntry',
        'expectedNegative',
        'status',
        'notRunReason',
        'errorAssertion',
        'sideEffectAssertion',
        'durationMs',
        'detail',
        'evidenceRefs',
      ],
      label,
    );
    const definition = P01_REQUIRED_CHECKS[index] as P01RequiredCheckDefinition;
    if (entry.id !== definition.id) {
      fail('invalid_report', `${label}.id 必须是 ${definition.id}（顺序固定），收到：${String(entry.id)}`);
    }
    if (
      typeof entry.status !== 'string' ||
      !CHECK_STATUSES.includes(entry.status as P01CheckStatus)
    ) {
      fail('invalid_report', `${label}.status 非法：${String(entry.status)}`);
    }
    const status = entry.status as P01CheckStatus;
    if (status === 'not_run') {
      if (
        typeof entry.notRunReason !== 'string' ||
        !NOT_RUN_REASONS.includes(entry.notRunReason as P01NotRunReason)
      ) {
        fail('invalid_report', `${label} 为 not_run 时 notRunReason 必须明确分类`);
      }
    } else if (entry.notRunReason !== null) {
      fail('invalid_report', `${label} 非 not_run 时 notRunReason 必须为 null`);
    }
    for (const key of ['errorAssertion', 'sideEffectAssertion'] as const) {
      const flag = entry[key];
      if (flag !== null && typeof flag !== 'boolean') {
        fail('invalid_report', `${label}.${key} 必须是布尔值或 null`);
      }
    }
    if (
      entry.expectedNegative === true &&
      status === 'pass' &&
      !(entry.errorAssertion === true && entry.sideEffectAssertion === true)
    ) {
      fail('invalid_report', `${label} 预期负例 pass 必须同时携带错误/副作用断言`);
    }
    if (entry.durationMs !== null) {
      if (
        typeof entry.durationMs !== 'number' ||
        !Number.isFinite(entry.durationMs) ||
        entry.durationMs < 0
      ) {
        fail('invalid_report', `${label}.durationMs 必须是非负有限数或 null`);
      }
    }
    if (entry.detail !== null && typeof entry.detail !== 'string') {
      fail('invalid_report', `${label}.detail 必须是字符串或 null`);
    }
    if (!Array.isArray(entry.evidenceRefs)) {
      fail('invalid_report', `${label}.evidenceRefs 必须是数组`);
    }
    for (const ref of entry.evidenceRefs as unknown[]) {
      seenEvidenceRefs.push(assertEvidenceReportPath(ref, `${label}.evidenceRefs`));
    }
  });

  if (!isPlainObject(report.counts)) {
    fail('invalid_report', 'counts 必须是对象');
  }
  const recomputed = aggregateP01CheckResults(
    checks.map((raw) => {
      const entry = raw as Record<string, unknown>;
      return {
        checkId: entry.id,
        status: entry.status,
        ...(entry.notRunReason !== null ? { notRunReason: entry.notRunReason } : {}),
        ...(entry.errorAssertion !== null ? { errorAssertion: entry.errorAssertion } : {}),
        ...(entry.sideEffectAssertion !== null
          ? { sideEffectAssertion: entry.sideEffectAssertion }
          : {}),
        ...(entry.durationMs !== null ? { durationMs: entry.durationMs } : {}),
        ...(entry.detail !== null ? { detail: entry.detail } : {}),
        evidenceRefs: entry.evidenceRefs,
      } as P01CheckResultInput;
    }),
  );
  const counts = report.counts as Record<string, unknown>;
  for (const key of ['pass', 'fail', 'not_run', 'total'] as const) {
    if (counts[key] !== recomputed.counts[key]) {
      fail(
        'invalid_report',
        `counts.${key} 与逐项结果不一致：报告=${String(counts[key])} 实算=${recomputed.counts[key]}`,
      );
    }
  }
  if (report.conclusion !== recomputed.conclusion) {
    fail(
      'invalid_report',
      `conclusion 与逐项结果不一致：报告=${String(report.conclusion)} 实算=${recomputed.conclusion}`,
    );
  }

  if (!Array.isArray(report.evidence)) {
    fail('invalid_report', 'evidence 必须是数组');
  }
  const manifestPaths = new Set<string>();
  for (const [index, raw] of (report.evidence as unknown[]).entries()) {
    const label = `evidence[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_report', `${label} 必须是对象`);
    }
    const entry = raw as Record<string, unknown>;
    assertAllowedKeys(entry, ['path', 'sha256', 'sizeBytes', 'checkId'], label);
    const path = assertEvidenceReportPath(entry.path, `${label}.path`);
    if (manifestPaths.has(path)) {
      fail('invalid_report', `${label}.path 重复：${path}`);
    }
    manifestPaths.add(path);
    assertSha256Digest(entry.sha256, `${label}.sha256`);
    if (
      typeof entry.sizeBytes !== 'number' ||
      !Number.isInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0
    ) {
      fail('invalid_report', `${label}.sizeBytes 必须是非负整数`);
    }
    if (entry.checkId !== null) {
      if (typeof entry.checkId !== 'string' || !REQUIRED_BY_ID.has(entry.checkId)) {
        fail('invalid_report', `${label}.checkId 未知：${String(entry.checkId)}`);
      }
    }
  }
  for (const ref of seenEvidenceRefs) {
    if (!manifestPaths.has(ref)) {
      fail('invalid_report', `检查引用的证据不在清单中：${ref}`);
    }
  }

  // 其余区块复用输入校验的语义（plan/git/platform/tools/schemaVersions/commands/…）。
  validateReportInput({
    runId: report.runId,
    generatedAtUtc: report.generatedAtUtc,
    plan: report.plan,
    git: report.git,
    platform: report.platform,
    tools: report.tools,
    schemaVersions: report.schemaVersions,
    commands: report.commands,
    results: [],
    ...(report.stateDigests !== undefined
      ? { stateDigests: report.stateDigests as P01AcceptanceReportInput['stateDigests'] }
      : {}),
    ...(report.outOfScope !== undefined
      ? { outOfScope: report.outOfScope as readonly P01OutOfScopeEntry[] }
      : {}),
    ...(report.knownLimitations !== undefined
      ? { knownLimitations: report.knownLimitations as readonly string[] }
      : {}),
  } as P01AcceptanceReportInput);

  return value as unknown as P01AcceptanceReport;
}

/**
 * 装配版本化报告：严格校验输入 → 聚合检查结果 → 交叉核对证据引用 →
 * 输出通过完整 Schema 校验的报告对象。
 */
export function buildP01AcceptanceReport(
  input: P01AcceptanceReportInput,
  evidenceManifest: readonly P01EvidenceManifestEntry[],
): P01AcceptanceReport {
  validateReportInput(input);
  const aggregation = aggregateP01CheckResults(input.results);

  if (!Array.isArray(evidenceManifest)) {
    fail('invalid_input', '证据清单必须是数组');
  }
  const manifestPaths = new Set<string>();
  const manifest: P01EvidenceManifestEntry[] = evidenceManifest.map((raw, index) => {
    const label = `证据清单[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_input', `${label} 必须是对象`);
    }
    const path = assertEvidenceReportPath(raw.path, `${label}.path`);
    if (manifestPaths.has(path)) {
      fail('invalid_input', `${label}.path 重复：${path}`);
    }
    manifestPaths.add(path);
    if (raw.checkId !== null && raw.checkId !== undefined) {
      if (typeof raw.checkId !== 'string' || !REQUIRED_BY_ID.has(raw.checkId)) {
        fail('unknown_check', `${label}.checkId 未知：${String(raw.checkId)}`);
      }
    }
    return {
      path,
      sha256: assertSha256Digest(raw.sha256, `${label}.sha256`),
      sizeBytes: ((): number => {
        if (
          typeof raw.sizeBytes !== 'number' ||
          !Number.isInteger(raw.sizeBytes) ||
          raw.sizeBytes < 0
        ) {
          fail('invalid_input', `${label}.sizeBytes 必须是非负整数`);
        }
        return raw.sizeBytes;
      })(),
      checkId: raw.checkId ?? null,
    };
  });
  for (const check of aggregation.checks) {
    for (const ref of check.evidenceRefs) {
      if (!manifestPaths.has(ref)) {
        fail('evidence_missing', `检查 ${check.id} 引用的证据不在清单中：${ref}`, ref);
      }
    }
  }

  const candidate: P01AcceptanceReport = {
    reportSchemaVersion: P01_ACCEPTANCE_REPORT_SCHEMA_VERSION,
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
    schemaVersions: {
      settingsSchema: input.schemaVersions.settingsSchema,
      settingsExportFormat: input.schemaVersions.settingsExportFormat,
      sqliteMigrations: [...input.schemaVersions.sqliteMigrations],
    },
    commands: validateCommands(input.commands),
    checks: aggregation.checks,
    counts: aggregation.counts,
    conclusion: aggregation.conclusion,
    evidence: manifest,
    stateDigests: { ...(input.stateDigests ?? {}) },
    outOfScope: validateOutOfScope(input.outOfScope),
    knownLimitations: [...(input.knownLimitations ?? [])],
  };
  return validateP01AcceptanceReport(candidate);
}

/* ------------------------------------------------------------------ *
 * 可读摘要（与 report.json 同一结果源）
 * ------------------------------------------------------------------ */

function summaryCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ');
}

function describeCheckStatus(check: P01AggregatedCheck): string {
  if (check.status === 'not_run') {
    return `not_run (${String(check.notRunReason)})`;
  }
  return check.status;
}

/** 由报告对象生成简明 Markdown 摘要；不引入报告之外的任何数据源。 */
export function renderP01Summary(report: P01AcceptanceReport): string {
  const lines: string[] = [];
  lines.push(`# P01 阶段验收摘要 — ${report.conclusion === 'pass' ? '通过' : '未通过'}`);
  lines.push('');
  lines.push(`- 运行 ID：\`${report.runId}\``);
  lines.push(`- 生成时间（UTC）：${report.generatedAtUtc}`);
  lines.push(`- 报告 Schema 版本：${report.reportSchemaVersion}`);
  lines.push(
    `- 输入计划：${summaryCell(report.plan.title)}（${summaryCell(report.plan.phaseId)}，版本 ${summaryCell(report.plan.version)}，摘要 ${report.plan.digestSha256}）`,
  );
  lines.push(`- 范围：${summaryCell(report.plan.scope)}`);
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
    `- Schema 版本：settings=${report.schemaVersions.settingsSchema} · 导出格式=${report.schemaVersions.settingsExportFormat} · SQLite 迁移=[${report.schemaVersions.sqliteMigrations.join(', ')}]`,
  );
  lines.push(
    `- 总体结论：**${report.conclusion}**（pass ${report.counts.pass} / fail ${report.counts.fail} / not_run ${report.counts.not_run}，必需检查共 ${report.counts.total} 项）`,
  );
  lines.push('');
  lines.push('## 必需检查结果');
  lines.push('');
  lines.push('| 检查 ID | 分支 | 状态 | 证据数 |');
  lines.push('|---|---|---|---|');
  for (const check of report.checks) {
    lines.push(
      `| ${check.id} | ${summaryCell(check.frBranch)} | ${describeCheckStatus(check)} | ${check.evidenceRefs.length} |`,
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
  lines.push('## 阶段外能力（不计入必需项通过数）');
  lines.push('');
  if (report.outOfScope.length === 0) {
    lines.push('（无）');
  } else {
    lines.push('| ID | 能力 | 状态 | 说明 |');
    lines.push('|---|---|---|---|');
    for (const entry of report.outOfScope) {
      lines.push(
        `| ${entry.id} | ${summaryCell(entry.capability)} | ${entry.status} | ${summaryCell(entry.note)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 证据清单');
  lines.push('');
  lines.push(
    `共 ${report.evidence.length} 项，均为报告目录内相对路径（${P01_EVIDENCE_DIR_NAME}/ 前缀）；逐项 sha256/sizeBytes 见 report.json。`,
  );
  for (const entry of report.evidence) {
    lines.push(
      `- \`${entry.path}\`${entry.checkId !== null ? `（${entry.checkId}）` : ''} — ${entry.sizeBytes} bytes`,
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
 * 报告写入与验证
 * ------------------------------------------------------------------ */

export interface P01EvidenceFileInput {
  /** 报告目录内相对路径（必须以 evidence/ 开头）。 */
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly checkId?: string | null;
}

export interface WriteP01AcceptanceReportOptions {
  /** 报告根目录（如 artifacts/acceptance/p01）；每次运行写入其下独立 <run-id>/。 */
  readonly reportRoot: string;
  readonly input: P01AcceptanceReportInput;
  readonly evidenceFiles?: readonly P01EvidenceFileInput[];
  /** 需要脱敏的敏感值（合成凭据等）；写入前对报告/摘要/证据统一脱敏并复核。 */
  readonly sensitiveValues?: readonly string[];
}

export interface P01WrittenReport {
  readonly runDir: string;
  readonly reportPath: string;
  readonly summaryPath: string;
  readonly report: P01AcceptanceReport;
  readonly counts: P01AggregationCounts;
  readonly conclusion: 'pass' | 'fail';
  readonly problems: readonly string[];
  /** 0 仅当全部必需检查 pass 且证据/摘要成功写出；否则 1。 */
  readonly exitCode: number;
}

/**
 * 写出一次运行的报告目录：<reportRoot>/<run-id>/{report.json,summary.md,evidence/…}。
 * - run-id 目录已存在即拒绝（不覆盖另一 run-id 的报告）；
 * - 证据先按敏感值脱敏再落盘，报告/摘要与证据同源同批写出；
 * - 全部内容在创建目录前完成校验；写出过程失败按 report_write_failed 抛出并尽力回收
 *   本次新建的半成品目录（失败路径绝不留下看似完整的报告）。
 */
export function writeP01AcceptanceReport(
  options: WriteP01AcceptanceReportOptions,
): P01WrittenReport {
  if (!isPlainObject(options)) {
    fail('invalid_input', '写入选项必须是对象');
  }
  assertNonEmptyString(options.reportRoot, 'reportRoot');
  const sensitive = normalizeSensitiveValues(options.sensitiveValues);
  const runId = assertValidRunId(options.input?.runId);

  // 1) 证据内容脱敏 + 摘要计算（在任何文件系统写入之前完成全部校验）。
  const evidenceInputs = options.evidenceFiles ?? [];
  const seenPaths = new Set<string>();
  const preparedEvidence: { path: string; bytes: Buffer; checkId: string | null }[] = [];
  for (const [index, entry] of evidenceInputs.entries()) {
    const label = `evidenceFiles[${index}]`;
    if (!isPlainObject(entry)) {
      fail('invalid_input', `${label} 必须是对象`);
    }
    const path = assertEvidenceReportPath(entry.path, `${label}.path`);
    if (seenPaths.has(path)) {
      fail('invalid_input', `${label}.path 重复：${path}`);
    }
    seenPaths.add(path);
    if (entry.checkId !== undefined && entry.checkId !== null) {
      if (typeof entry.checkId !== 'string' || !REQUIRED_BY_ID.has(entry.checkId)) {
        fail('unknown_check', `${label}.checkId 未知：${String(entry.checkId)}`);
      }
    }
    if (typeof entry.content !== 'string' && !(entry.content instanceof Uint8Array)) {
      fail('invalid_input', `${label}.content 必须是字符串或字节`);
    }
    let bytes: Buffer;
    if (typeof entry.content === 'string') {
      const redacted = redactSensitiveText(entry.content, sensitive);
      assertNoSensitiveText(redacted, sensitive, `${label}.content`);
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
    }
    preparedEvidence.push({ path, bytes, checkId: entry.checkId ?? null });
  }
  const manifest: P01EvidenceManifestEntry[] = preparedEvidence.map((entry) => ({
    path: entry.path,
    sha256: sha256Hex(entry.bytes),
    sizeBytes: entry.bytes.length,
    checkId: entry.checkId,
  }));

  // 2) 装配并全量校验报告（含聚合与证据交叉引用）。
  const report = buildP01AcceptanceReport(options.input, manifest);
  const aggregation = aggregateP01CheckResults(options.input.results);

  // 3) 序列化（同一结果源）+ 脱敏复核。
  const reportJson = redactSensitiveText(`${JSON.stringify(report, null, 2)}\n`, sensitive);
  const summary = redactSensitiveText(renderP01Summary(report), sensitive);
  assertNoSensitiveText(reportJson, sensitive, P01_REPORT_FILE_NAME);
  assertNoSensitiveText(summary, sensitive, P01_SUMMARY_FILE_NAME);

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
    writeFileSync(join(runDir, P01_REPORT_FILE_NAME), reportJson, 'utf-8');
    writeFileSync(join(runDir, P01_SUMMARY_FILE_NAME), summary, 'utf-8');
  } catch (error) {
    if (created) {
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        // 尽力回收半成品目录；原始错误优先。
      }
    }
    if (error instanceof P01ReportError) {
      throw error;
    }
    fail('report_write_failed', `报告写入失败：${(error as Error).message}`, runId);
  }

  return {
    runDir,
    reportPath: join(runDir, P01_REPORT_FILE_NAME),
    summaryPath: join(runDir, P01_SUMMARY_FILE_NAME),
    report,
    counts: report.counts,
    conclusion: report.conclusion,
    problems: aggregation.problems,
    exitCode: computeP01PhaseExitCode({
      conclusion: report.conclusion,
      evidenceOk: true,
      reportWritten: true,
    }),
  };
}

export interface P01ReportVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * 重新核验已写出的报告目录：report.json 可解析且通过严格 Schema 校验、
 * summary.md 在位、证据清单逐项存在且 size/sha256 匹配（缺失/损坏都计入问题）。
 */
export function verifyP01ReportDirectory(runDir: string): P01ReportVerification {
  const problems: string[] = [];
  const reportPath = join(runDir, P01_REPORT_FILE_NAME);
  if (!existsSync(reportPath)) {
    return { ok: false, problems: [`缺少 ${P01_REPORT_FILE_NAME}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf-8'));
  } catch (error) {
    return { ok: false, problems: [`${P01_REPORT_FILE_NAME} 无法解析：${(error as Error).message}`] };
  }
  let report: P01AcceptanceReport;
  try {
    report = validateP01AcceptanceReport(parsed);
  } catch (error) {
    if (error instanceof P01ReportError) {
      return { ok: false, problems: [`报告 Schema 非法：${error.message}`] };
    }
    throw error;
  }
  if (!existsSync(join(runDir, P01_SUMMARY_FILE_NAME))) {
    problems.push(`缺少 ${P01_SUMMARY_FILE_NAME}`);
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
      problems.push(`证据损坏（size 不符）：${entry.path}（清单 ${entry.sizeBytes}，实际 ${bytes.length}）`);
      continue;
    }
    if (sha256Hex(bytes) !== entry.sha256) {
      problems.push(`证据损坏（sha256 不符）：${entry.path}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
