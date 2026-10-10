/**
 * P02-4 / F-009 版本化 P02 阶段验收报告、证据清单与严格结果聚合器
 * （开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口；
 * 也不新建通用事件或报告平台——本模块只服务 P02-4 阶段验收）。
 *
 * 沿用 P01-4 / F-007 的验收模式（scripts/acceptance/p01-report.ts），按
 * `docs/p02-4-acceptance-contract.md`（F-001）冻结的 P02 约定实现：
 * - 15 个必需检查 ID 在此以机器可读形式固定（`P02_REQUIRED_CHECKS`，顺序即报告与
 *   聚合的固定顺序）；未知或重复的检查 ID 一律拒绝，不得聚合为通过；
 * - 每个检查结果只有 pass / fail / not_run 三态；未提交结果、启动失败、超时与被
 *   跳过的必需项全部归类为 not_run（携带 notRunReason 分类），空结果集不得聚合
 *   为通过；
 * - 预期负例（expectedNegative：拒绝/冲突/失败分支）的 pass 必须携带并满足该检查
 *   定义的断言集合：error（错误/状态断言）、zeroStart（零启动断言：实际命令/
 *   基线进程启动次数为零、未知脚本零执行）、persistentState（持久状态断言：项目/
 *   配置/检查/源文件状态不变或按预期保留）。业务 not_run 的拒绝用例（如
 *   `P02-FR2-BASELINE-FAILURE` 的拒绝授权分支）只有零启动及持久状态断言成立才可
 *   作为检查 pass，否则降级为 fail；
 * - 报告记录输入计划版本/摘要、范围、受测 commit 与工作树状态、前序基线、UTC
 *   时间、OS/架构、实际工具版本、Schema 版本（settings/导出格式/SQLite 迁移/
 *   应用线消息/事件封套）、命令 argv/逻辑 cwd/退出码/耗时、逐项结果、代码与
 *   持久状态摘要、证据路径/hash/size 及已知限制；业务身份只用检查 ID；
 * - JSON 报告（report.json）与可读摘要（summary.md）由同一结果源生成；每次运行
 *   写入独立 <reportRoot>/<run-id>/ 目录（默认 reportRoot 为
 *   `artifacts/acceptance/p02`），已存在的 run-id 拒绝覆盖，不覆盖此前证据；
 * - 证据引用为报告目录内相对路径（evidence/ 前缀）且带 hash/size。证据内容必须
 *   在临时资源清理前以内存内容传入本模块（模块不读取临时目录，天然不可能在
 *   清理后导出）；保留非秘密实例/锁/退出、项目/配置/检查、Git 文件摘要与基线
 *   输出核对等脱敏事实；
 * - 不导出完整环境变量（Schema 无环境字段、未知字段拒绝）、认证文件或原始秘密：
 *   写入前对报告 JSON、摘要与证据附件统一按敏感值脱敏并复核（secret_leak），
 *   且扫描凭据形状（凭据键名 / Bearer 认证头形态）——未脱敏的认证文件内容或
 *   认证头一律拒绝写出；
 * - 阶段外能力（Pi/模型 Live、其他平台、强沙箱）以 P02-OOS-* 记录为
 *   not_run/unsupported，不计入必需项通过数；
 * - 任一必需 fail 或 not_run、缺失/损坏证据、报告写入失败都使阶段退出码非零
 *   （computeP02PhaseExitCode / verifyP02ReportDirectory）。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接
 * 运行；不调用模型，不联网，不修改受检仓库中的任何文件（只写 reportRoot 下的
 * 运行目录）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/* ------------------------------------------------------------------ *
 * 常量与错误
 * ------------------------------------------------------------------ */

export const P02_ACCEPTANCE_REPORT_SCHEMA_VERSION = 1;
export const P02_REPORT_FILE_NAME = 'report.json';
export const P02_SUMMARY_FILE_NAME = 'summary.md';
export const P02_EVIDENCE_DIR_NAME = 'evidence';
/** 报告默认根（相对仓库根；F-010/F-011 的配置与控制器沿用此约定）。 */
export const P02_DEFAULT_REPORT_ROOT = 'artifacts/acceptance/p02';

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUN_ID_MAX_LENGTH = 128;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const LOGICAL_LOCATION_PATTERN = /^<[A-Za-z0-9][A-Za-z0-9._-]*>(\/[A-Za-z0-9._-]+)*$/;
const OUT_OF_SCOPE_ID_PATTERN = /^P02-OOS-[A-Z0-9][A-Z0-9-]*$/;

export type P02ReportErrorKind =
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

export class P02ReportError extends Error {
  readonly kind: P02ReportErrorKind;
  readonly detail?: string;

  constructor(kind: P02ReportErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'P02ReportError';
    this.kind = kind;
    this.detail = detail;
  }
}

function fail(kind: P02ReportErrorKind, message: string, detail?: string): never {
  throw new P02ReportError(kind, message, detail);
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/* ------------------------------------------------------------------ *
 * 冻结的必需检查清单（契约 §2.1；顺序固定）
 * ------------------------------------------------------------------ */

/** 预期负例必须携带并满足的断言分类。 */
export type P02AssertionKind = 'error' | 'zeroStart' | 'persistentState';

export interface P02RequiredCheckDefinition {
  readonly id: string;
  readonly group: 'ENG' | 'FR1' | 'FR2' | 'PHASE';
  /** 承接的 FR / 阶段分支（契约 §2.1 第二列语义）。 */
  readonly frBranch: string;
  readonly summary: string;
  /** 实际测试 / 命令入口（契约 §2.1；F-011/F-012 入口为约定路径）。 */
  readonly testEntry: string;
  /** 预期负例：拒绝/冲突/失败分支检查。 */
  readonly expectedNegative: boolean;
  /** expectedNegative 时 pass 必须携带并满足的断言集合（契约 §2.2/§2.5）。 */
  readonly requiredAssertions: readonly P02AssertionKind[];
}

export const P02_REQUIRED_CHECKS: readonly P02RequiredCheckDefinition[] = [
  {
    id: 'P02-ENG-VERIFY',
    group: 'ENG',
    frBranch: '工程',
    summary: 'npm run verify（锁文件预检 + test/typecheck/build）退出 0',
    testEntry: 'npm run verify',
    expectedNegative: false,
    requiredAssertions: [],
  },
  {
    id: 'P02-FR1-UNIQUE-HOST',
    group: 'FR1',
    frBranch: 'FR-1 唯一 Host',
    summary:
      '双真实 dist CLI 同步竞争同一临时数据根：恰一持锁 Host/写入者、同一 hostInstanceId 与数据根身份、127.0.0.1 随机端口、发现目录权限合规',
    testEntry: 'test/p02-4-dual-cli-acceptance.test.ts',
    expectedNegative: false,
    requiredAssertions: [],
  },
  {
    id: 'P02-FR1-SHARED-STATE',
    group: 'FR1',
    frBranch: 'FR-1 共享项目/配置',
    summary:
      'CLI A 确认注册 + 配置写入后，CLI B 经列表/详情/overview/配置查询读到同一 projectId、绑定、描述、标签、当前值、revision 与有效来源',
    testEntry: 'test/p02-4-dual-cli-acceptance.test.ts',
    expectedNegative: false,
    requiredAssertions: [],
  },
  {
    id: 'P02-FR1-BASELINE-OK',
    group: 'FR1',
    frBranch: 'FR-1 授权基线',
    summary:
      '用户明确确认的确定性成功命令：双客户端查询同一 operationId、逐项检查结果、退出码 0、代码身份与可校验输出制品；accepted 不作 passed 依据',
    testEntry: 'test/p02-4-dual-cli-acceptance.test.ts',
    expectedNegative: false,
    requiredAssertions: [],
  },
  {
    id: 'P02-FR2-DUPLICATE-INIT',
    group: 'FR2',
    frBranch: 'FR-2 重复初始化',
    summary:
      '同规范路径及其真实路径别名重复 init 得同一 projectId；项目/绑定各一份，原名称/描述/标签/配置未被重复初始化覆盖',
    testEntry: 'test/p02-4-idempotency-acceptance.test.ts',
    expectedNegative: true,
    requiredAssertions: ['error', 'persistentState'],
  },
  {
    id: 'P02-FR2-COMMAND-CONFLICT',
    group: 'FR2',
    frBranch: 'FR-2 命令重放/冲突',
    summary:
      '显式同一 commandId 重放返回原持久回执与结果身份、零重复副作用；同 principal/commandId 异参数得 conflict 且无额外变更，原回执仍可查',
    testEntry: 'test/p02-4-idempotency-acceptance.test.ts',
    expectedNegative: true,
    requiredAssertions: ['error', 'zeroStart', 'persistentState'],
  },
  {
    id: 'P02-FR2-SOURCE-PRESERVED',
    group: 'FR2',
    frBranch: 'FR-2 源文件保留',
    summary:
      '干净/脏仓库接入前后 HEAD、索引、Git 状态与文件摘要一致；恶意脚本哨兵零执行、无意外产物；取消确认按契约返回 not_run 且零启动',
    testEntry: 'test/p02-4-repo-preservation-acceptance.test.ts',
    expectedNegative: true,
    requiredAssertions: ['error', 'zeroStart', 'persistentState'],
  },
  {
    id: 'P02-FR2-AUTH-REJECT',
    group: 'FR2',
    frBranch: 'FR-2 认证拒绝',
    summary:
      '缺失/错误 token、旧实例身份、数据根不匹配、未知协议/Schema、非法输入、越权与监听覆盖明确拒绝；零副作用、实际绑定 127.0.0.1 且不泄漏凭据',
    testEntry: 'test/p02-4-negative-acceptance.test.ts',
    expectedNegative: true,
    requiredAssertions: ['error', 'zeroStart', 'persistentState'],
  },
  {
    id: 'P02-FR2-CLIENT-EXIT',
    group: 'FR2',
    frBranch: 'FR-2 客户端退出',
    summary:
      '运行基线时退出/中断 CLI 的 wait/follow（observation_interrupted）：不发 stop/cancel、Host 存活、另一 CLI 仍可认证查询同一 Host',
    testEntry: 'test/p02-4-restart-acceptance.test.ts',
    expectedNegative: true,
    requiredAssertions: ['error', 'persistentState'],
  },
  {
    id: 'P02-FR1-RESTART-QUERY',
    group: 'FR1',
    frBranch: 'FR-1 重启查询',
    summary:
      '正式显式 host stop 核验后重启取新 hostInstanceId；新 CLI 读到原 projectId、配置值/revision、基线结果、代码身份与输出制品 hash/size 一致；旧凭据被拒、原基线不重跑',
    testEntry: 'test/p02-4-restart-acceptance.test.ts',
    expectedNegative: false,
    requiredAssertions: [],
  },
  {
    id: 'P02-FR2-BASELINE-FAILURE',
    group: 'FR2',
    frBranch: 'FR-2 基线失败',
    summary:
      '固定非零退出、拒绝授权 not_run（零启动）、缺命令/未知脚本、超时/取消/停止未确认；失败不撤销注册、不删证据、不冒充通过',
    testEntry: 'test/p02-4-baseline-failure-acceptance.test.ts',
    expectedNegative: true,
    requiredAssertions: ['error', 'zeroStart', 'persistentState'],
  },
  {
    id: 'P02-PHASE-FIXTURE',
    group: 'PHASE',
    frBranch: '夹具失败',
    summary: '夹具准备失败明确 fail/not_run，阶段非零，保留已取得证据并回收自有进程/临时资源',
    testEntry: 'test/p02-4-acceptance-controller.test.ts',
    expectedNegative: false,
    requiredAssertions: [],
  },
  {
    id: 'P02-PHASE-NOT-RUN',
    group: 'PHASE',
    frBranch: '必需检查未运行',
    summary: '未提交结果/启动失败/超时/被跳过的必需项标 not_run，不得聚合为通过',
    testEntry: 'test/p02-4-report-aggregation.test.ts',
    expectedNegative: false,
    requiredAssertions: [],
  },
  {
    id: 'P02-PHASE-REPORT',
    group: 'PHASE',
    frBranch: '报告完整性',
    summary: '版本化报告 Schema、逐项结果、证据 path/hash/size、脱敏与总体结论可验证',
    testEntry: 'test/p02-4-acceptance-report.test.ts',
    expectedNegative: false,
    requiredAssertions: [],
  },
  {
    id: 'P02-ENG-CLEAN-REPLAY',
    group: 'ENG',
    frBranch: '重复运行不依赖残留',
    summary:
      '干净源码快照 npm ci/build 后从非源码 cwd 连续两次 accept:p02 均退出 0；run-id/报告/临时资源独立、互不覆盖',
    testEntry: 'test/p02-4-clean-replay.test.ts',
    expectedNegative: false,
    requiredAssertions: [],
  },
];

export const P02_REQUIRED_CHECK_IDS: readonly string[] = P02_REQUIRED_CHECKS.map(
  (definition) => definition.id,
);

const REQUIRED_BY_ID: ReadonlyMap<string, P02RequiredCheckDefinition> = new Map(
  P02_REQUIRED_CHECKS.map((definition) => [definition.id, definition]),
);

/* ------------------------------------------------------------------ *
 * 检查结果与聚合
 * ------------------------------------------------------------------ */

export type P02CheckStatus = 'pass' | 'fail' | 'not_run';

/** not_run 的明确分类：未提交结果 / 启动失败（含夹具失败）/ 超时 / 被跳过。 */
export type P02NotRunReason = 'missing_result' | 'startup_failure' | 'timeout' | 'skipped';

const CHECK_STATUSES: readonly P02CheckStatus[] = ['pass', 'fail', 'not_run'];
const NOT_RUN_REASONS: readonly P02NotRunReason[] = [
  'missing_result',
  'startup_failure',
  'timeout',
  'skipped',
];

/** 调用方提交的单项检查结果（聚合器输入）。 */
export interface P02CheckResultInput {
  readonly checkId: string;
  readonly status: P02CheckStatus;
  /** status=not_run 时必填的明确分类；其他状态不得携带。 */
  readonly notRunReason?: P02NotRunReason;
  /** 错误/状态断言：拒绝、冲突、失败或业务 not_run 的错误码/状态与预期一致。 */
  readonly errorAssertion?: boolean;
  /** 零启动断言：实际命令/基线进程启动次数为零；未知脚本零执行。 */
  readonly zeroStartAssertion?: boolean;
  /** 持久状态断言：项目/配置/检查/源文件等持久状态不变或按预期保留。 */
  readonly persistentStateAssertion?: boolean;
  readonly durationMs?: number;
  readonly detail?: string;
  /** 报告内相对证据路径（必须以 evidence/ 开头）。 */
  readonly evidenceRefs?: readonly string[];
}

export interface P02AggregatedCheck {
  readonly id: string;
  readonly group: string;
  readonly frBranch: string;
  readonly summary: string;
  readonly testEntry: string;
  readonly expectedNegative: boolean;
  readonly requiredAssertions: readonly P02AssertionKind[];
  readonly status: P02CheckStatus;
  readonly notRunReason: P02NotRunReason | null;
  readonly errorAssertion: boolean | null;
  readonly zeroStartAssertion: boolean | null;
  readonly persistentStateAssertion: boolean | null;
  readonly durationMs: number | null;
  readonly detail: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface P02AggregationCounts {
  readonly pass: number;
  readonly fail: number;
  readonly not_run: number;
  readonly total: number;
}

export interface P02Aggregation {
  readonly checks: readonly P02AggregatedCheck[];
  readonly counts: P02AggregationCounts;
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
  if (segments[0] !== P02_EVIDENCE_DIR_NAME || segments.length < 2) {
    fail('unsafe_path', `${label} 必须位于 ${P02_EVIDENCE_DIR_NAME}/ 之内：${normalized}`);
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

function assertionValue(
  kind: P02AssertionKind,
  entry: Record<string, unknown>,
): boolean | null {
  const key =
    kind === 'error'
      ? 'errorAssertion'
      : kind === 'zeroStart'
        ? 'zeroStartAssertion'
        : 'persistentStateAssertion';
  return assertOptionalBoolean(entry[key], `检查 ${String(entry.checkId)} 的 ${key}`);
}

/**
 * 严格聚合提交的检查结果：
 * - 未知 / 重复检查 ID 直接拒绝（unknown_check / duplicate_check）；
 * - 未提交的必需检查记 not_run（missing_result）；
 * - not_run 必须携带明确分类；pass/fail 不得携带 notRunReason；
 * - 预期负例 pass 缺少定义要求的断言（error/zeroStart/persistentState 之一不成立）
 *   即降级为 fail；业务 not_run 的拒绝用例只有零启动及持久状态断言成立才可计 pass；
 * - 结论 pass 当且仅当全部必需检查均为 pass。
 */
export function aggregateP02CheckResults(
  results: readonly P02CheckResultInput[],
): P02Aggregation {
  if (!Array.isArray(results)) {
    fail('invalid_input', '检查结果必须是数组');
  }
  const byId = new Map<string, P02AggregatedCheck>();
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
      !CHECK_STATUSES.includes(entry.status as P02CheckStatus)
    ) {
      fail('invalid_result', `检查 ${checkId} 的 status 非法：${String(entry.status)}`);
    }
    const status = entry.status as P02CheckStatus;
    const notRunReasonRaw = entry.notRunReason;
    let notRunReason: P02NotRunReason | null = null;
    if (status === 'not_run') {
      if (
        typeof notRunReasonRaw !== 'string' ||
        !NOT_RUN_REASONS.includes(notRunReasonRaw as P02NotRunReason)
      ) {
        fail(
          'invalid_result',
          `检查 ${checkId} 为 not_run 时必须携带明确分类（${NOT_RUN_REASONS.join('/') }）`,
        );
      }
      notRunReason = notRunReasonRaw as P02NotRunReason;
    } else if (notRunReasonRaw !== undefined && notRunReasonRaw !== null) {
      fail('invalid_result', `检查 ${checkId} 非 not_run 状态不得携带 notRunReason`);
    }
    const detail = entry.detail === undefined || entry.detail === null ? null : entry.detail;
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
      requiredAssertions: [...definition.requiredAssertions],
      status,
      notRunReason,
      errorAssertion: assertionValue('error', entry),
      zeroStartAssertion: assertionValue('zeroStart', entry),
      persistentStateAssertion: assertionValue('persistentState', entry),
      durationMs: assertOptionalDuration(entry.durationMs, `检查 ${checkId} 的 durationMs`),
      detail: detail as string | null,
      evidenceRefs: validateEvidenceRefs(entry.evidenceRefs, `检查 ${checkId} 的 evidenceRefs`),
    });
  }

  for (const definition of P02_REQUIRED_CHECKS) {
    if (!byId.has(definition.id)) {
      byId.set(definition.id, {
        id: definition.id,
        group: definition.group,
        frBranch: definition.frBranch,
        summary: definition.summary,
        testEntry: definition.testEntry,
        expectedNegative: definition.expectedNegative,
        requiredAssertions: [...definition.requiredAssertions],
        status: 'not_run',
        notRunReason: 'missing_result',
        errorAssertion: null,
        zeroStartAssertion: null,
        persistentStateAssertion: null,
        durationMs: null,
        detail: null,
        evidenceRefs: [],
      });
      problems.push(`${definition.id}: 未提交结果（not_run/missing_result）`);
    }
  }

  const checks: P02AggregatedCheck[] = [];
  for (const definition of P02_REQUIRED_CHECKS) {
    const entry = byId.get(definition.id) as P02AggregatedCheck;
    if (entry.expectedNegative && entry.status === 'pass') {
      const missing = definition.requiredAssertions.filter((kind) => {
        if (kind === 'error') {
          return entry.errorAssertion !== true;
        }
        if (kind === 'zeroStart') {
          return entry.zeroStartAssertion !== true;
        }
        return entry.persistentStateAssertion !== true;
      });
      if (missing.length > 0) {
        const note = `预期负例缺少必需断言（${missing.join('/')}），不计为通过`;
        const downgraded: P02AggregatedCheck = {
          ...entry,
          status: 'fail',
          detail: entry.detail === null ? note : `${entry.detail}；${note}`,
        };
        checks.push(downgraded);
        problems.push(`${definition.id}: ${note}`);
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

  const counts: P02AggregationCounts = {
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
export function computeP02PhaseExitCode(input: {
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
export function generateP02RunId(nowUtc: Date, randomSuffixHex?: string): string {
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
 * 脱敏（敏感值替换 + 凭据形状扫描）
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

/** 凭据键名形状（JSON 键：token/auth/authorization/password/secret/credential/cookie/apikey）。 */
const CREDENTIAL_KEY_TEXT_PATTERN =
  /"(?:authorization|auth|token|password|secret|credential|cookie|api[_-]?key)s?"\s*:/gi;
/** Bearer 认证头形态（值域不含 [REDACTED 占位符，脱敏后不再命中）。 */
const BEARER_TEXT_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * 扫描文本中的凭据形状（键名 / Bearer 认证头），返回命中描述（无命中为空）。
 * 用于报告/摘要/证据导出前的 fail-closed 校验：认证文件内容或认证头不得进入报告。
 */
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

/** 凭据形状命中即拒绝（secret_leak；不得复制认证文件/认证头）。 */
export function assertNoCredentialShapesInText(text: string, label: string): void {
  const hits = scanTextForCredentialShapes(text);
  if (hits.length > 0) {
    fail('secret_leak', `${label} 含凭据形状，拒绝写出（不得复制认证文件或认证头）`, hits[0]);
  }
}

/* ------------------------------------------------------------------ *
 * 报告输入与报告结构（Schema v1）
 * ------------------------------------------------------------------ */

export interface P02CommandRecord {
  readonly label: string;
  /** 显式 argv（不经 Shell 拼接）。 */
  readonly argv: readonly string[];
  /** 逻辑 cwd（<repo> 等形式），不记录个人绝对路径。 */
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut?: boolean;
}

export interface P02OutOfScopeEntry {
  /** 必须 P02-OOS-* 前缀，不得与必需检查 ID 冲突。 */
  readonly id: string;
  readonly capability: string;
  readonly status: 'not_run' | 'unsupported';
  readonly note: string;
}

export interface P02EvidenceManifestEntry {
  /** 报告目录内相对路径（evidence/ 前缀）。 */
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** 关联的必需检查 ID（可为空，如全局快照）。 */
  readonly checkId: string | null;
}

export interface P02AcceptanceReportInput {
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
    /** 应用线消息 schemaVersion（P02-3 起为 3）。 */
    readonly applicationWireSchema: number;
    /** 事件封套 schemaVersion（当前为 1）。 */
    readonly eventEnvelopeSchema: number;
  };
  readonly commands: readonly P02CommandRecord[];
  readonly results: readonly P02CheckResultInput[];
  readonly stateDigests?: {
    readonly businessInputSha256?: string;
    readonly codeSha256?: string;
    readonly persistentStateSha256?: string;
  };
  readonly outOfScope?: readonly P02OutOfScopeEntry[];
  readonly knownLimitations?: readonly string[];
}

export interface P02AcceptanceReport {
  readonly reportSchemaVersion: number;
  readonly runId: string;
  readonly generatedAtUtc: string;
  readonly plan: P02AcceptanceReportInput['plan'];
  readonly git: P02AcceptanceReportInput['git'];
  readonly platform: P02AcceptanceReportInput['platform'];
  readonly tools: P02AcceptanceReportInput['tools'];
  readonly schemaVersions: P02AcceptanceReportInput['schemaVersions'];
  readonly commands: readonly P02CommandRecord[];
  readonly checks: readonly P02AggregatedCheck[];
  readonly counts: P02AggregationCounts;
  readonly conclusion: 'pass' | 'fail';
  readonly evidence: readonly P02EvidenceManifestEntry[];
  readonly stateDigests: NonNullable<P02AcceptanceReportInput['stateDigests']>;
  readonly outOfScope: readonly P02OutOfScopeEntry[];
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

function validateCommands(value: unknown): readonly P02CommandRecord[] {
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

function validateOutOfScope(value: unknown): readonly P02OutOfScopeEntry[] {
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
      fail('invalid_input', `${label}.id 必须匹配 P02-OOS-*：${id}`);
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

function validateReportInput(input: P02AcceptanceReportInput): void {
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
  for (const key of [
    'settingsSchema',
    'settingsExportFormat',
    'applicationWireSchema',
    'eventEnvelopeSchema',
  ] as const) {
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

const CHECK_ENTRY_KEYS = [
  'id',
  'group',
  'frBranch',
  'summary',
  'testEntry',
  'expectedNegative',
  'requiredAssertions',
  'status',
  'notRunReason',
  'errorAssertion',
  'zeroStartAssertion',
  'persistentStateAssertion',
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

/**
 * 严格校验报告对象（Schema v1）：版本、字段、未知字段、检查 ID 集合与顺序、
 * 断言集合与冻结定义一致、状态/分类一致性、计数与结论重算、证据清单形态与
 * 交叉引用。非法报告一律抛 invalid_report（路径类违规抛 unsafe_path）。
 */
export function validateP02AcceptanceReport(value: unknown): P02AcceptanceReport {
  if (!isPlainObject(value)) {
    fail('invalid_report', '报告必须是对象');
  }
  const report = value as Record<string, unknown>;
  assertAllowedKeys(report, REPORT_TOP_LEVEL_KEYS, '报告');

  if (report.reportSchemaVersion !== P02_ACCEPTANCE_REPORT_SCHEMA_VERSION) {
    fail(
      'invalid_report',
      `reportSchemaVersion 必须是 ${P02_ACCEPTANCE_REPORT_SCHEMA_VERSION}，收到：${String(report.reportSchemaVersion)}`,
    );
  }
  assertValidRunId(report.runId);
  assertUtcIso(report.generatedAtUtc, 'generatedAtUtc');

  if (!Array.isArray(report.checks)) {
    fail('invalid_report', 'checks 必须是数组');
  }
  const checks = report.checks as unknown[];
  if (checks.length !== P02_REQUIRED_CHECKS.length) {
    fail('invalid_report', `checks 必须恰好 ${P02_REQUIRED_CHECKS.length} 项`);
  }
  const seenEvidenceRefs: string[] = [];
  checks.forEach((raw, index) => {
    const label = `checks[${index}]`;
    if (!isPlainObject(raw)) {
      fail('invalid_report', `${label} 必须是对象`);
    }
    const entry = raw as Record<string, unknown>;
    assertAllowedKeys(entry, CHECK_ENTRY_KEYS, label);
    const definition = P02_REQUIRED_CHECKS[index] as P02RequiredCheckDefinition;
    if (entry.id !== definition.id) {
      fail('invalid_report', `${label}.id 必须是 ${definition.id}（顺序固定），收到：${String(entry.id)}`);
    }
    if (entry.group !== definition.group || entry.frBranch !== definition.frBranch) {
      fail('invalid_report', `${label} 的 group/frBranch 与冻结定义不一致`);
    }
    if (entry.expectedNegative !== definition.expectedNegative) {
      fail('invalid_report', `${label}.expectedNegative 与冻结定义不一致`);
    }
    if (
      !Array.isArray(entry.requiredAssertions) ||
      entry.requiredAssertions.length !== definition.requiredAssertions.length ||
      entry.requiredAssertions.some(
        (kind, kindIndex) => kind !== definition.requiredAssertions[kindIndex],
      )
    ) {
      fail('invalid_report', `${label}.requiredAssertions 与冻结定义不一致`);
    }
    if (
      typeof entry.status !== 'string' ||
      !CHECK_STATUSES.includes(entry.status as P02CheckStatus)
    ) {
      fail('invalid_report', `${label}.status 非法：${String(entry.status)}`);
    }
    const status = entry.status as P02CheckStatus;
    if (status === 'not_run') {
      if (
        typeof entry.notRunReason !== 'string' ||
        !NOT_RUN_REASONS.includes(entry.notRunReason as P02NotRunReason)
      ) {
        fail('invalid_report', `${label} 为 not_run 时 notRunReason 必须明确分类`);
      }
    } else if (entry.notRunReason !== null) {
      fail('invalid_report', `${label} 非 not_run 时 notRunReason 必须为 null`);
    }
    for (const key of [
      'errorAssertion',
      'zeroStartAssertion',
      'persistentStateAssertion',
    ] as const) {
      const flag = entry[key];
      if (flag !== null && typeof flag !== 'boolean') {
        fail('invalid_report', `${label}.${key} 必须是布尔值或 null`);
      }
    }
    if (
      definition.expectedNegative === true &&
      status === 'pass' &&
      !definition.requiredAssertions.every((kind) => {
        if (kind === 'error') {
          return entry.errorAssertion === true;
        }
        if (kind === 'zeroStart') {
          return entry.zeroStartAssertion === true;
        }
        return entry.persistentStateAssertion === true;
      })
    ) {
      fail(
        'invalid_report',
        `${label} 预期负例 pass 必须携带并满足断言集合（${definition.requiredAssertions.join('/')}）`,
      );
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
  const recomputed = aggregateP02CheckResults(
    checks.map((raw) => {
      const entry = raw as Record<string, unknown>;
      return {
        checkId: entry.id,
        status: entry.status,
        ...(entry.notRunReason !== null ? { notRunReason: entry.notRunReason } : {}),
        ...(entry.errorAssertion !== null ? { errorAssertion: entry.errorAssertion } : {}),
        ...(entry.zeroStartAssertion !== null
          ? { zeroStartAssertion: entry.zeroStartAssertion }
          : {}),
        ...(entry.persistentStateAssertion !== null
          ? { persistentStateAssertion: entry.persistentStateAssertion }
          : {}),
        ...(entry.durationMs !== null ? { durationMs: entry.durationMs } : {}),
        ...(entry.detail !== null ? { detail: entry.detail } : {}),
        evidenceRefs: entry.evidenceRefs,
      } as P02CheckResultInput;
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
      ? { stateDigests: report.stateDigests as P02AcceptanceReportInput['stateDigests'] }
      : {}),
    ...(report.outOfScope !== undefined
      ? { outOfScope: report.outOfScope as readonly P02OutOfScopeEntry[] }
      : {}),
    ...(report.knownLimitations !== undefined
      ? { knownLimitations: report.knownLimitations as readonly string[] }
      : {}),
  } as P02AcceptanceReportInput);

  return value as unknown as P02AcceptanceReport;
}

/**
 * 装配版本化报告：严格校验输入 → 聚合检查结果 → 交叉核对证据引用 →
 * 输出通过完整 Schema 校验的报告对象。
 */
export function buildP02AcceptanceReport(
  input: P02AcceptanceReportInput,
  evidenceManifest: readonly P02EvidenceManifestEntry[],
): P02AcceptanceReport {
  validateReportInput(input);
  const aggregation = aggregateP02CheckResults(input.results);

  if (!Array.isArray(evidenceManifest)) {
    fail('invalid_input', '证据清单必须是数组');
  }
  const manifestPaths = new Set<string>();
  const manifest: P02EvidenceManifestEntry[] = evidenceManifest.map((raw, index) => {
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

  const candidate: P02AcceptanceReport = {
    reportSchemaVersion: P02_ACCEPTANCE_REPORT_SCHEMA_VERSION,
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
      applicationWireSchema: input.schemaVersions.applicationWireSchema,
      eventEnvelopeSchema: input.schemaVersions.eventEnvelopeSchema,
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
  return validateP02AcceptanceReport(candidate);
}

/* ------------------------------------------------------------------ *
 * 可读摘要（与 report.json 同一结果源）
 * ------------------------------------------------------------------ */

function summaryCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ');
}

function describeCheckStatus(check: P02AggregatedCheck): string {
  if (check.status === 'not_run') {
    return `not_run (${String(check.notRunReason)})`;
  }
  return check.status;
}

/** 由报告对象生成简明 Markdown 摘要；不引入报告之外的任何数据源。 */
export function renderP02Summary(report: P02AcceptanceReport): string {
  const lines: string[] = [];
  lines.push(`# P02 阶段验收摘要 — ${report.conclusion === 'pass' ? '通过' : '未通过'}`);
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
    `- Schema 版本：settings=${report.schemaVersions.settingsSchema} · 导出格式=${report.schemaVersions.settingsExportFormat} · SQLite 迁移=[${report.schemaVersions.sqliteMigrations.join(', ')}] · 线消息=${report.schemaVersions.applicationWireSchema} · 事件封套=${report.schemaVersions.eventEnvelopeSchema}`,
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
    `共 ${report.evidence.length} 项，均为报告目录内相对路径（${P02_EVIDENCE_DIR_NAME}/ 前缀），在临时资源清理前导出；逐项 sha256/sizeBytes 见 report.json。`,
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

export interface P02EvidenceFileInput {
  /** 报告目录内相对路径（必须以 evidence/ 开头）。 */
  readonly path: string;
  /**
   * 证据内容（内存字节）：调用方必须在临时资源清理前采集并传入；
   * 本模块不读取任何临时目录，写入后与清单 hash/size 一致。
   */
  readonly content: string | Uint8Array;
  readonly checkId?: string | null;
}

export interface WriteP02AcceptanceReportOptions {
  /** 报告根目录（如 artifacts/acceptance/p02）；每次运行写入其下独立 <run-id>/。 */
  readonly reportRoot: string;
  readonly input: P02AcceptanceReportInput;
  readonly evidenceFiles?: readonly P02EvidenceFileInput[];
  /** 需要脱敏的敏感值（合成凭据、开发机路径等）；写入前对报告/摘要/证据统一脱敏并复核。 */
  readonly sensitiveValues?: readonly string[];
}

export interface P02WrittenReport {
  readonly runDir: string;
  readonly reportPath: string;
  readonly summaryPath: string;
  readonly report: P02AcceptanceReport;
  readonly counts: P02AggregationCounts;
  readonly conclusion: 'pass' | 'fail';
  readonly problems: readonly string[];
  /** 0 仅当全部必需检查 pass 且证据/摘要成功写出；否则 1。 */
  readonly exitCode: number;
}

/**
 * 写出一次运行的报告目录：<reportRoot>/<run-id>/{report.json,summary.md,evidence/…}。
 * - run-id 目录已存在即拒绝（不覆盖另一 run-id 的报告与证据）；
 * - 证据先按敏感值脱敏并做凭据形状扫描（不复制认证文件/认证头），再计算摘要；
 *   报告/摘要与证据同源同批写出；
 * - 全部内容在创建目录前完成校验；写出过程失败按 report_write_failed 抛出并尽力
 *   回收本次新建的半成品目录（失败路径绝不留下看似完整的报告）。
 */
export function writeP02AcceptanceReport(
  options: WriteP02AcceptanceReportOptions,
): P02WrittenReport {
  if (!isPlainObject(options)) {
    fail('invalid_input', '写入选项必须是对象');
  }
  assertNonEmptyString(options.reportRoot, 'reportRoot');
  const sensitive = normalizeSensitiveValues(options.sensitiveValues);
  const runId = assertValidRunId(options.input?.runId);

  // 1) 证据内容脱敏 + 凭据形状扫描 + 摘要计算（在任何文件系统写入之前完成全部校验）。
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
      assertNoCredentialShapesInText(redacted, `${label}.content`);
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
      assertNoCredentialShapesInText(bytes.toString('utf-8'), `${label}.content`);
    }
    preparedEvidence.push({ path, bytes, checkId: entry.checkId ?? null });
  }
  const manifest: P02EvidenceManifestEntry[] = preparedEvidence.map((entry) => ({
    path: entry.path,
    sha256: sha256Hex(entry.bytes),
    sizeBytes: entry.bytes.length,
    checkId: entry.checkId,
  }));

  // 2) 装配并全量校验报告（含聚合与证据交叉引用）。
  const report = buildP02AcceptanceReport(options.input, manifest);
  const aggregation = aggregateP02CheckResults(options.input.results);

  // 3) 序列化（同一结果源）+ 脱敏复核 + 凭据形状扫描。
  const reportJson = redactSensitiveText(`${JSON.stringify(report, null, 2)}\n`, sensitive);
  const summary = redactSensitiveText(renderP02Summary(report), sensitive);
  assertNoSensitiveText(reportJson, sensitive, P02_REPORT_FILE_NAME);
  assertNoSensitiveText(summary, sensitive, P02_SUMMARY_FILE_NAME);
  assertNoCredentialShapesInText(reportJson, P02_REPORT_FILE_NAME);
  assertNoCredentialShapesInText(summary, P02_SUMMARY_FILE_NAME);

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
    writeFileSync(join(runDir, P02_REPORT_FILE_NAME), reportJson, 'utf-8');
    writeFileSync(join(runDir, P02_SUMMARY_FILE_NAME), summary, 'utf-8');
  } catch (error) {
    if (created) {
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        // 尽力回收半成品目录；原始错误优先。
      }
    }
    if (error instanceof P02ReportError) {
      throw error;
    }
    fail('report_write_failed', `报告写入失败：${(error as Error).message}`, runId);
  }

  return {
    runDir,
    reportPath: join(runDir, P02_REPORT_FILE_NAME),
    summaryPath: join(runDir, P02_SUMMARY_FILE_NAME),
    report,
    counts: report.counts,
    conclusion: report.conclusion,
    problems: aggregation.problems,
    exitCode: computeP02PhaseExitCode({
      conclusion: report.conclusion,
      evidenceOk: true,
      reportWritten: true,
    }),
  };
}

export interface P02ReportVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * 重新核验已写出的报告目录：report.json 可解析且通过严格 Schema 校验、
 * summary.md 在位、证据清单逐项存在且 size/sha256 匹配（缺失/损坏都计入问题）。
 */
export function verifyP02ReportDirectory(runDir: string): P02ReportVerification {
  const problems: string[] = [];
  const reportPath = join(runDir, P02_REPORT_FILE_NAME);
  if (!existsSync(reportPath)) {
    return { ok: false, problems: [`缺少 ${P02_REPORT_FILE_NAME}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf-8'));
  } catch (error) {
    return { ok: false, problems: [`${P02_REPORT_FILE_NAME} 无法解析：${(error as Error).message}`] };
  }
  let report: P02AcceptanceReport;
  try {
    report = validateP02AcceptanceReport(parsed);
  } catch (error) {
    if (error instanceof P02ReportError) {
      return { ok: false, problems: [`报告 Schema 非法：${error.message}`] };
    }
    throw error;
  }
  if (!existsSync(join(runDir, P02_SUMMARY_FILE_NAME))) {
    problems.push(`缺少 ${P02_SUMMARY_FILE_NAME}`);
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
