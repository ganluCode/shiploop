/**
 * P07-5 / F-001 P07 阶段验收契约：冻结清单、场景矩阵、证据类别与执行策略
 * （开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口）。
 *
 * 复用 P01～P06 已建立的验收契约机制（scripts/acceptance/p06-config.ts、
 * p05-test-scope.ts），按 input/p07-acceptance.md §2、§3 与 readiness.md 冻结
 * P07 专属的版本化输入契约：
 *
 * - **清单驱动**：FR-1（阶段闭环演示）与 FR-2（负例与证据）逐项映射设计验收索引
 *   T06（崩溃/旧进程核对）、T08（提交恢复/公共元数据锁）、T11（Recorder 背压与
 *   原生档案）、T12（通知独立重试）、T15（归档删除边界）、T16（备份/升级恢复）
 *   的具名场景；每项冻结 ID、分组、验证层次、执行类别、前序 Feature、设计索引、
 *   断言与必需事实类别。缺项、重复身份、未知版本、空检查集合、删减断言、改写
 *   执行类别一律拒绝，不以测试数量证明需求覆盖；
 * - **前置门槛**：P07-1～P07-4 未交付、公开接口不满足、交付证据缺失或提交祖先
 *   关系不成立时输出结构化前置阻塞（blocked/not_run），不得以占位实现或补库放行；
 *   Node 22.19.0、npm 10.9.3、macOS、默认单并发和有限执行预算写入验收契约；
 * - **两种模式**：默认阶段模式执行阶段可信合集、受影响回归与既有工程检查
 *   （typecheck / 边界 / build，复用 verify --checks-only 与 check:boundaries）；
 *   无参数 npm run verify 的全仓测试语义保持原样、未被阶段入口修改，全仓历史回归
 *   只能经 --full-regression 显式开启。两种模式的范围与输入摘要不同；默认报告
 *   不得声称无参数 verify 或全仓历史回归已经通过；
 * - **严格三态**：pass / fail / not_run；not_run 不计通过，deferred 不计通过，
 *   manual pending/rejected 不能由机器代签；缺证据类别即 fail，不以日志成功文本
 *   或测试数量作为通过依据。P07 不新增 live 必需门槛，不调用真实模型。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接运行。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const P07_CHECKLIST_VERSION = 1;
export const P07_ACCEPT_CONFIG_VERSION = 1;
export const P07_ENTRY_SCHEMA_VERSION = 1;
export const P07_CHECKLIST_PATH = 'acceptance/p07.checklist.json';
export const P07_ACCEPT_CONFIG_PATH = 'acceptance/p07.config.json';
export const P07_ENTRY_PATH = 'acceptance/p07.entry.json';

/** 前序交付 Feature；P07-5 为本验收 Feature 本身，不进入前置清单。 */
export const P07_PREREQUISITE_FEATURES = ['P07-1', 'P07-2', 'P07-3', 'P07-4'] as const;
export type P07PrerequisiteFeature = (typeof P07_PREREQUISITE_FEATURES)[number];
export const P07_ACCEPT_FEATURE = 'P07-5';
export const P07_LAYERS = ['unit', 'feature-integration', 'phase-acceptance'] as const;
export type P07Layer = (typeof P07_LAYERS)[number];
/** P07 验收无 live 必需门槛：真实模型调用不属于本阶段默认门禁。 */
export const P07_EXECUTION_TYPES = ['offline', 'manual', 'postponed'] as const;
export type P07ExecutionType = (typeof P07_EXECUTION_TYPES)[number];
export const P07_EVIDENCE_CATEGORIES = [
  'command-exit', 'sqlite', 'git', 'process', 'artifact', 'report', 'manifest',
  'budget', 'notification', 'archive', 'sha', 'usage', 'manual', 'cleanup',
] as const;
export type P07EvidenceCategory = (typeof P07_EVIDENCE_CATEGORIES)[number];
export const P07_FR_IDS = ['FR-1', 'FR-2'] as const;
/** 本阶段设计验收索引（core-design/09 测试矩阵）；PRD §3.2 逐项映射到具名场景。 */
export const P07_DESIGN_INDEXES = ['T06', 'T08', 'T11', 'T12', 'T15', 'T16'] as const;
export type P07DesignIndex = (typeof P07_DESIGN_INDEXES)[number];
export const P07_REPORT_STATUSES = ['pass', 'fail', 'not_run'] as const;
export type P07ReportStatus = (typeof P07_REPORT_STATUSES)[number];

export const P07_COUNT_RULE =
  '必需项全部 pass 才算通过；not_run 和人工 pending 不计入通过；deferred 项不参与通过计数；覆盖按必需断言与可观察事实判定，不按日志成功文本或测试数量判断';

/** 工具链与运行资格：macOS、Node 22.19.0、npm 10.9.3、默认单并发。 */
export const P07_TOOLCHAIN = {
  packageManager: 'npm@10.9.3', node: '22.19.0', npm: '10.9.3', lockfile: 'package-lock.json',
  platform: 'darwin', platformLabel: 'macOS', defaultConcurrency: 1,
} as const;
export const P07_FAKE_IDENTITY = {
  provider: 'fake-provider', model: 'fake-model', realModel: false, network: 'denied',
} as const;
export const P07_TEMP_RESOURCES = {
  git: 'temp', sqlite: 'temp', dataRoot: 'temp', home: 'temp', processes: 'owned-only', reusePrevious: false,
} as const;
export const P07_EXECUTION_POLICY = {
  offline: { runtime: 'fake-or-scripted', network: 'denied', llmCalls: false },
  manual: { ownerConfirmationRequired: true, machineMaySign: false },
  notRun: { countsAsPassed: false },
} as const;
export const P07_LIVE_POLICY = {
  requiredGate: false, realModelCalls: 'not-authorized-by-default', note: 'P07 阶段验收不新增 live 必需门槛；真实模型须负责人独立授权与预算',
} as const;
export const P07_REPORT_SCOPE = {
  statuses: ['pass', 'fail', 'not_run'], includeEvidenceHash: true, includeManualChecklist: true,
  notRunCountsAsPassed: false, deferredCountsAsPassed: false,
} as const;
/** 工程检查（类型/边界/构建）复用既有入口；无参数 verify 的全仓语义不变。 */
export const P07_ENGINEERING_CHECKS = {
  typecheck: 'npm run typecheck',
  boundaries: 'npm run check:boundaries',
  build: 'npm run build',
  checksOnlyEntry: 'node scripts/verify.ts --checks-only',
  note: 'typecheck/build 复用 verify --checks-only；模块边界检查使用 check:boundaries',
} as const;
export const P07_VERIFY_SEMANTICS = {
  noArgCommand: ['npm', 'run', 'verify'],
  noArgSteps: ['typecheck', 'test', 'build'],
  modifiedByPhaseEntry: false,
  noArgRunClaimableByPhaseReport: false,
  reason: '无参数 npm run verify 仍执行全仓测试+类型+构建；阶段入口不修改该语义，也不得在报告中声称其已通过',
} as const;
export const P07_MODES = {
  default: {
    name: 'phase',
    phaseTrustedTests: true,
    affectedRegressions: true,
    engineeringChecks: { typecheck: 'npm run typecheck', boundaries: 'npm run check:boundaries', build: 'npm run build' },
    fullRepositoryTests: false,
    mayClaim: ['phase-scope-passed', 'engineering-checks-passed'],
    mustNotClaim: ['no-arg-verify-passed', 'full-history-regression-passed'],
  },
  full: {
    name: 'full',
    phaseTrustedTests: true,
    affectedRegressions: true,
    engineeringChecks: { typecheck: 'npm run typecheck', boundaries: 'npm run check:boundaries', build: 'npm run build' },
    fullRepositoryTests: true,
    fullRegressionCommand: ['npm', 'test'],
    optIn: '--full-regression',
    mayClaim: ['phase-scope-passed', 'engineering-checks-passed', 'full-history-regression-passed'],
    mustNotClaim: ['no-arg-verify-passed'],
  },
} as const;
export const P07_ENTRY_STEP_ORDER = ['p07-prerequisites', 'p07-trusted-scope', 'p07-recovery-scenarios', 'p07-report', 'p07-manual-gate'] as const;
export const P07_ENTRY_EVIDENCE_REQUIRED_FIELDS = [
  'scenarioId', 'inputDigest', 'testedCommit', 'command', 'exitCode', 'status', 'evidenceRefs', 'usageSource', 'cleanup',
] as const;

export type P07ItemGroup = 'fr' | 'scenario' | 'manual' | 'deferred';
export type P07FrozenItem = {
  readonly id: string;
  readonly group: P07ItemGroup;
  readonly title: string;
  readonly layer: P07Layer;
  readonly execution: P07ExecutionType;
  readonly features: readonly string[];
  readonly designIndexes: readonly string[];
  readonly fr: readonly string[];
  readonly acceptanceRefs: readonly string[];
  readonly assertions: readonly string[];
  readonly evidence: readonly P07EvidenceCategory[];
};

const FR_ITEMS: readonly P07FrozenItem[] = [
  {
    id: 'P07-FR1-RECOVERY-CLOSURE', group: 'fr', title: 'FR-1 阶段闭环恢复演示', layer: 'phase-acceptance', execution: 'offline',
    features: [...P07_PREREQUISITE_FEATURES], designIndexes: [], fr: ['FR-1'], acceptanceRefs: ['FR-1', 'AC-1', 'AC-2', 'P07-5'],
    assertions: [
      '在验证或提交边界终止 Host 后重启，先核对旧进程与 Git 事实再显式恢复；未确认停止前保持隔离或阻塞，不自动重试、不派发新执行',
      '故障后代码保留、预算/deadline 不清零、依赖不误解锁、通知失败不重跑任务四项同时成立，并用持久状态与证据断言',
      '备份恢复后记录与制品匹配；重复运行使用独立 run-id 与临时资源，不依赖上一次残留；清理不触及用户仓库',
    ],
    evidence: ['command-exit', 'sqlite', 'git', 'process', 'artifact', 'manifest', 'budget', 'notification', 'sha', 'usage', 'cleanup'],
  },
  {
    id: 'P07-FR2-NEGATIVE-EVIDENCE', group: 'fr', title: 'FR-2 负例与证据完整性', layer: 'phase-acceptance', execution: 'offline',
    features: [...P07_PREREQUISITE_FEATURES], designIndexes: [], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'AC-3', 'AC-4', 'AC-5', 'P07-5'],
    assertions: [
      '每项检查绑定场景 ID、输入摘要、受测 commit、实际命令、退出码、状态和必需事实类别；正常完成文本或测试数量不构成通过依据',
      '每个失败用例核对结果、状态与是否产生意外副作用；不能靠手工改 SQLite、忽略失败或跳过必需检查通过',
      '敏感凭据与开发机绝对路径不进入报告；not_run 与已知缺口如实展示，默认模式不得声称无参数 verify 或全仓历史回归已通过',
    ],
    evidence: ['command-exit', 'artifact', 'report', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const SCENARIO_ITEMS: readonly P07FrozenItem[] = [
  {
    id: 'P07-T06-VERIFIER-CRASH-RECOVERY', group: 'scenario', title: 'T06 验证边界 Host 崩溃与显式恢复', layer: 'feature-integration', execution: 'offline',
    features: ['P07-1'], designIndexes: ['T06'], fr: ['FR-1'], acceptanceRefs: ['T06', 'FR-1', 'AC-2', 'P07-1'],
    assertions: [
      '真实 Verifier 已进入等待屏障时终止自有 Host；重启后核对旧 Runner/Verifier 身份、文件与占用，未确认停止保持隔离并拒绝新执行',
      '确认停止并核对安全现场后经公开命令显式恢复；保留旧 Attempt 与 tracked/untracked 改动，新 Attempt 复用已核验工作区，预算与绝对 deadline 累计不清零',
      '重复/重叠恢复命令、旧 owner/hostInstanceId/executionVersion 迟到结果和取消/完成竞争只产生获准的一次新认领或启动，迟到结果不覆盖当前业务状态',
    ],
    evidence: ['command-exit', 'sqlite', 'git', 'process', 'budget', 'sha', 'cleanup'],
  },
  {
    id: 'P07-T08-COMMIT-RECEIPT-RECOVERY', group: 'scenario', title: 'T08 提交已发生但回执丢失的恢复与公共元数据锁', layer: 'feature-integration', execution: 'offline',
    features: ['P07-1'], designIndexes: ['T08'], fr: ['FR-1'], acceptanceRefs: ['T08', 'FR-1', 'AC-2'],
    assertions: [
      '提交已发生但回执丢失时，恢复以真实 Git HEAD/tree/worktree 事实核对，不重复提交、不丢失已提交代码，也不把未核对事实记为成功',
      '新旧仓库身份争用同一公共元数据锁；binding 身份漂移或路径相同但实体不同被拒绝，不靠路径相同推断实体相同',
      '失败/部分完成保留现场，脏目录不清理；错误目录/分支拒绝，恢复幂等复用唯一 worktree 登记',
    ],
    evidence: ['git', 'sqlite', 'process', 'artifact', 'sha', 'cleanup'],
  },
  {
    id: 'P07-T11-RECORDER-BACKPRESSURE', group: 'scenario', title: 'T11 Recorder 背压、输出上限与持久化失败', layer: 'feature-integration', execution: 'offline',
    features: ['P07-2'], designIndexes: ['T11'], fr: ['FR-1'], acceptanceRefs: ['T11', 'FR-1', 'AC-2'],
    assertions: [
      '重复消息去重、长输出有界截断、未知事件明确拒绝或登记、原生存档补录可核对；队列与输出不无限积累',
      'Recorder 持久化失败受有限预算控制并阻塞执行推进，不静默丢记录；背压事实与水位/缺口如实展示',
    ],
    evidence: ['sqlite', 'artifact', 'manifest', 'usage', 'cleanup'],
  },
  {
    id: 'P07-T11-NATIVE-ARCHIVE-SINGLE-WRITER', group: 'scenario', title: 'T11 原生档案异常、单写入者与双存储不一致', layer: 'feature-integration', execution: 'offline',
    features: ['P07-2'], designIndexes: ['T11'], fr: ['FR-1'], acceptanceRefs: ['T11', 'FR-1', 'AC-2'],
    assertions: [
      '原生存储缺失/损坏/不兼容、第二写入者打开同一档案和双存储不一致时明确拒绝或修复后继续，不以 SDK 恢复能力替代 Core 结果',
      '单写入者约束核验通过才允许续接；unsupported/not_run 不计为通过，未运行能力不宣称为支持',
    ],
    evidence: ['sqlite', 'process', 'artifact', 'manifest', 'sha', 'cleanup'],
  },
  {
    id: 'P07-T12-NOTIFICATION-INDEPENDENT-RETRY', group: 'scenario', title: 'T12 通知独立重试、重复投递与结果查询', layer: 'feature-integration', execution: 'offline',
    features: ['P07-4'], designIndexes: ['T12'], fr: ['FR-1'], acceptanceRefs: ['T12', 'FR-1', 'AC-2'],
    assertions: [
      '通知失败、重复渠道投递和 Host 重启不重跑任务；投递经游标与 delivery 记录独立重试，状态可查询',
      '事件重连与重复投递幂等；结果查询反映真实业务状态与证据，不以通知成功替代业务验收',
    ],
    evidence: ['sqlite', 'notification', 'report', 'usage', 'cleanup'],
  },
  {
    id: 'P07-T15-ARCHIVE-DELETE-RETENTION', group: 'scenario', title: 'T15 归档、删除确认与记录保留边界', layer: 'feature-integration', execution: 'offline',
    features: ['P07-3'], designIndexes: ['T15'], fr: ['FR-1'], acceptanceRefs: ['T15', 'FR-1', 'AC-2'],
    assertions: [
      '项目归档、删除预览/确认和记录保留政策按声明边界执行；删除需显式确认，预览不产生副作用',
      '保留政策到期清理与备份/归档互不误解锁；越界删除、无确认删除被拒绝且状态不变',
    ],
    evidence: ['sqlite', 'git', 'artifact', 'archive', 'cleanup'],
  },
  {
    id: 'P07-T16-BACKUP-RESTORE-CONSISTENCY', group: 'scenario', title: 'T16 备份恢复、制品一致性与升级失败恢复', layer: 'feature-integration', execution: 'offline',
    features: ['P07-3'], designIndexes: ['T16'], fr: ['FR-1'], acceptanceRefs: ['T16', 'FR-1', 'AC-2'],
    assertions: [
      'SQLite 备份恢复后记录与制品匹配；Artifact 不一致恢复后完整性检查通过或明确失败，不以单次正常运行代替故障验收',
      '数据库升级失败不留下半迁移状态：安全回滚或阻塞启动；恢复后的完整性检查绑定事实证据',
    ],
    evidence: ['sqlite', 'artifact', 'manifest', 'sha', 'cleanup'],
  },
  {
    id: 'P07-RERUN-EVIDENCE-INTEGRITY', group: 'scenario', title: '重复运行隔离与证据完整性', layer: 'phase-acceptance', execution: 'offline',
    features: [...P07_PREREQUISITE_FEATURES], designIndexes: [], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'AC-4', 'AC-5', 'P07-5'],
    assertions: [
      '重复运行使用独立 run-id 与临时资源，不依赖上一次残留资源；报告绑定 runId、受测 commit 与输入摘要',
      '证据哈希、身份或结构不匹配时 fail-closed；not_run、deferred 与人工 pending 不得折算为通过',
    ],
    evidence: ['report', 'artifact', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const MANUAL_ITEMS: readonly P07FrozenItem[] = [
  {
    id: 'P07-MANUAL-OWNER-GATE', group: 'manual', title: 'P07 负责人 macOS 操作与阶段放行', layer: 'phase-acceptance', execution: 'manual',
    features: [...P07_PREREQUISITE_FEATURES], designIndexes: [], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'AC-4', 'AC-5'],
    assertions: [
      '负责人按 macOS 清单记录完整 SHA、实际命令、退出码、用量来源、清理事实和未执行项，并明确确认时间与结论',
      'pending/rejected、缺签署、SHA 不匹配时阶段结论不能通过；机器成功不能代签',
    ],
    evidence: ['manual', 'report', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const DEFERRED_ITEMS: readonly P07FrozenItem[] = [
  {
    id: 'P07-POST-FULL-HISTORY-REGRESSION', group: 'deferred', title: '后置：全仓历史回归', layer: 'phase-acceptance', execution: 'postponed',
    features: [...P07_PREREQUISITE_FEATURES], designIndexes: [], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'FULL-REGRESSION'],
    assertions: [
      '全仓历史回归只能由显式 --full-regression 选项或发布验收发起，不属于默认 P07 阶段门禁',
      '未运行全仓回归报告为 not_run，不计入阶段通过；无参数 npm run verify 未执行时同样不得声称通过',
    ],
    evidence: ['command-exit', 'report', 'manifest'],
  },
];

export const P07_FROZEN_ITEMS: readonly P07FrozenItem[] = [
  ...FR_ITEMS, ...SCENARIO_ITEMS, ...MANUAL_ITEMS, ...DEFERRED_ITEMS,
];
export const P07_REQUIRED_CHECK_IDS = P07_FROZEN_ITEMS.filter(item => item.group !== 'deferred').map(item => item.id);
export const P07_DEFERRED_IDS = P07_FROZEN_ITEMS.filter(item => item.group === 'deferred').map(item => item.id);
const ITEM_BY_ID = new Map(P07_FROZEN_ITEMS.map(item => [item.id, item]));

const CHECKLIST_KEYS = ['checklistVersion', 'phase', 'layers', 'executionTypes', 'evidenceCategories', 'countRule', 'items'] as const;
const ITEM_KEYS = ['id', 'group', 'title', 'layer', 'execution', 'features', 'designIndexes', 'fr', 'acceptanceRefs', 'assertions', 'evidence'] as const;
const CONFIG_KEYS = ['configVersion', 'checklist', 'reportRoot', 'requiredChecks', 'toolchain', 'timeouts', 'maxCommandOutputBytes', 'fakeIdentity', 'tempResources', 'executionPolicy', 'livePolicy', 'reportScope', 'engineeringChecks', 'verifySemantics', 'modes', 'fullRegression', 'usageSources', 'plan'] as const;
const ENTRY_KEYS = ['schemaVersion', 'phase', 'stepOrder', 'trustedIndexRoot', 'requiredFeatures', 'prerequisites', 'defaultExecution', 'modes', 'verify', 'explicitOptions', 'evidence', 'toolchain', 'budget'] as const;
const CREDENTIAL_KEY = /(?:authorization|auth|token|password|passwd|secret|credential|cookie|api[_-]?key)/i;
const BUSINESS_KEY = /^(?:schemaVersions|migrations?|settings|database|productConfig|businessConfig)$/i;
const ID_PATTERN = /^P07-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const REF_PATTERN = /^(?:FR-[1-2]|T(?:06|08|11|12|15|16)|P07-[1-5]|AC-[1-5]|FULL-REGRESSION)$/;

export type P07AcceptErrorKind = 'invalid_config';

export class P07AcceptError extends Error {
  readonly kind: P07AcceptErrorKind;
  readonly detail?: string;
  constructor(kind: P07AcceptErrorKind, message: string, detail?: string) { super(message); this.name = 'P07AcceptError'; this.kind = kind; this.detail = detail; }
}
function fail(message: string, detail?: string): never { throw new P07AcceptError('invalid_config', message, detail); }
function object(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象`); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEY.test(key)) fail(`${label} 含凭据字段：${key}`);
    if (BUSINESS_KEY.test(key)) fail(`${label} 含业务配置字段：${key}`);
    if (!allowed.includes(key)) fail(`${label} 含未知字段：${key}`);
  }
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) fail(`${label} 必须是非空字符串数组`);
  return [...value as string[]];
}
function exactStrings(value: unknown, expected: readonly string[], label: string): string[] {
  const actual = strings(value, label);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} 与冻结基线不一致`);
  return actual;
}
function bool(value: unknown, label: string): boolean { if (typeof value !== 'boolean') fail(`${label} 必须是布尔值`); return value; }
function bounded(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label} 必须是 ${min}~${max} 的有限整数`);
  return value;
}
function relativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || isAbsolute(value) || value.split('/').some(part => part === '' || part === '.' || part === '..')) fail(`${label} 必须是仓库内 POSIX 相对路径`);
  return value;
}
function same(value: unknown, expected: unknown, label: string): void { if (JSON.stringify(value) !== JSON.stringify(expected)) fail(`${label} 与冻结基线不一致`); }

function validateItem(rawValue: unknown, index: number): void {
  const raw = object(rawValue, `items[${index}]`);
  keys(raw, ITEM_KEYS, `items[${index}]`);
  for (const key of ITEM_KEYS) if (!(key in raw)) fail(`items[${index}] 缺少字段：${key}`);
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) fail(`items[${index}].id 非法`);
  const expected = ITEM_BY_ID.get(raw.id);
  if (!expected) fail(`items[${index}] 含未知检查：${raw.id}`);
  if (raw.group !== expected.group || raw.title !== expected.title || raw.layer !== expected.layer || raw.execution !== expected.execution) fail(`检查 ${raw.id} 的身份或执行类别被改写`);
  exactStrings(raw.features, expected.features, `${raw.id}.features`);
  const designIndexes = exactStrings(raw.designIndexes, expected.designIndexes, `${raw.id}.designIndexes`);
  if (designIndexes.some(value => !P07_DESIGN_INDEXES.includes(value as P07DesignIndex))) fail(`${raw.id}.designIndexes 含未知设计索引`);
  const fr = exactStrings(raw.fr, expected.fr, `${raw.id}.fr`);
  if (fr.some(value => !P07_FR_IDS.includes(value as (typeof P07_FR_IDS)[number]))) fail(`${raw.id}.fr 含未知 FR`);
  const refs = exactStrings(raw.acceptanceRefs, expected.acceptanceRefs, `${raw.id}.acceptanceRefs`);
  if (refs.some(value => !REF_PATTERN.test(value))) fail(`${raw.id}.acceptanceRefs 含未知引用`);
  exactStrings(raw.assertions, expected.assertions, `${raw.id}.assertions`);
  const evidence = exactStrings(raw.evidence, expected.evidence, `${raw.id}.evidence`);
  if (evidence.some(value => !P07_EVIDENCE_CATEGORIES.includes(value as P07EvidenceCategory))) fail(`${raw.id}.evidence 含未知类别`);
}

export type P07Checklist = {
  readonly checklistVersion: 1; readonly phase: 'P07'; readonly layers: readonly P07Layer[]; readonly executionTypes: readonly P07ExecutionType[];
  readonly evidenceCategories: readonly P07EvidenceCategory[]; readonly countRule: string; readonly items: readonly P07FrozenItem[];
};

export function validateP07Checklist(value: unknown): P07Checklist {
  const raw = object(value, 'checklist');
  keys(raw, CHECKLIST_KEYS, 'checklist');
  if (raw.checklistVersion !== P07_CHECKLIST_VERSION || raw.phase !== 'P07') fail('清单版本或阶段不匹配');
  exactStrings(raw.layers, P07_LAYERS, 'layers');
  exactStrings(raw.executionTypes, P07_EXECUTION_TYPES, 'executionTypes');
  exactStrings(raw.evidenceCategories, P07_EVIDENCE_CATEGORIES, 'evidenceCategories');
  if (raw.countRule !== P07_COUNT_RULE) fail('countRule 被改写');
  if (!Array.isArray(raw.items) || raw.items.length !== P07_FROZEN_ITEMS.length) fail('items 数量与冻结清单不一致');
  const seen = new Set<string>();
  (raw.items as unknown[]).forEach((item, index) => {
    validateItem(item, index);
    const id = (item as { id: string }).id;
    if (seen.has(id)) fail(`检查 ID 重复：${id}`);
    seen.add(id);
    if (id !== P07_FROZEN_ITEMS[index].id) fail(`检查顺序被改写：${id}`);
  });
  // 需求覆盖缺项拒绝：每个 FR、设计索引与前序 Feature 必须被必需检查覆盖，
  // 不以测试数量或清单长度证明需求覆盖。
  const required = P07_FROZEN_ITEMS.filter(item => item.group !== 'deferred');
  for (const fr of P07_FR_IDS) if (!required.some(item => item.fr.includes(fr))) fail(`必需检查缺少 FR 覆盖：${fr}`);
  for (const designIndex of P07_DESIGN_INDEXES) if (!required.some(item => item.designIndexes.includes(designIndex))) fail(`必需检查缺少设计索引场景映射：${designIndex}`);
  for (const feature of P07_PREREQUISITE_FEATURES) if (!required.some(item => item.features.includes(feature))) fail(`必需检查缺少前序 Feature 覆盖：${feature}`);
  return { checklistVersion: P07_CHECKLIST_VERSION, phase: 'P07', layers: [...P07_LAYERS], executionTypes: [...P07_EXECUTION_TYPES], evidenceCategories: [...P07_EVIDENCE_CATEGORIES], countRule: P07_COUNT_RULE, items: P07_FROZEN_ITEMS };
}

export type P07FullRegression = { readonly defaultEnabled: false; readonly optInFlag: '--full-regression'; readonly command: readonly string[]; readonly reason: string };
export type P07AcceptanceConfig = {
  readonly configVersion: 1; readonly checklist: string; readonly reportRoot: string; readonly requiredChecks: readonly string[];
  readonly toolchain: typeof P07_TOOLCHAIN; readonly timeouts: { readonly stepMs: number; readonly overallMs: number };
  readonly maxCommandOutputBytes: number; readonly fakeIdentity: typeof P07_FAKE_IDENTITY; readonly tempResources: typeof P07_TEMP_RESOURCES;
  readonly executionPolicy: typeof P07_EXECUTION_POLICY; readonly livePolicy: typeof P07_LIVE_POLICY; readonly reportScope: typeof P07_REPORT_SCOPE;
  readonly engineeringChecks: typeof P07_ENGINEERING_CHECKS; readonly verifySemantics: typeof P07_VERIFY_SEMANTICS; readonly modes: typeof P07_MODES;
  readonly fullRegression: P07FullRegression;
  readonly usageSources: readonly string[]; readonly plan: { readonly phaseId: string; readonly stepId: string; readonly title: string; readonly scope: string; readonly version: string; readonly contractDoc: string };
};

export function validateP07AcceptanceConfig(value: unknown): P07AcceptanceConfig {
  const raw = object(value, 'config'); keys(raw, CONFIG_KEYS, 'config');
  if (raw.configVersion !== P07_ACCEPT_CONFIG_VERSION) fail('configVersion 不匹配');
  const checklist = relativePath(raw.checklist, 'checklist');
  const reportRoot = relativePath(raw.reportRoot, 'reportRoot');
  exactStrings(raw.requiredChecks, P07_REQUIRED_CHECK_IDS, 'requiredChecks');
  same(raw.toolchain, P07_TOOLCHAIN, 'toolchain'); same(raw.fakeIdentity, P07_FAKE_IDENTITY, 'fakeIdentity'); same(raw.tempResources, P07_TEMP_RESOURCES, 'tempResources');
  same(raw.executionPolicy, P07_EXECUTION_POLICY, 'executionPolicy'); same(raw.livePolicy, P07_LIVE_POLICY, 'livePolicy'); same(raw.reportScope, P07_REPORT_SCOPE, 'reportScope');
  same(raw.engineeringChecks, P07_ENGINEERING_CHECKS, 'engineeringChecks'); same(raw.verifySemantics, P07_VERIFY_SEMANTICS, 'verifySemantics'); same(raw.modes, P07_MODES, 'modes');
  const timeouts = object(raw.timeouts, 'timeouts'); keys(timeouts, ['stepMs', 'overallMs'], 'timeouts');
  const stepMs = bounded(timeouts.stepMs, P07_ACCEPT_MIN_TIMEOUT_MS, P07_ACCEPT_MAX_TIMEOUT_MS, 'timeouts.stepMs');
  const overallMs = bounded(timeouts.overallMs, P07_ACCEPT_MIN_TIMEOUT_MS, P07_ACCEPT_MAX_OVERALL_MS, 'timeouts.overallMs');
  if (overallMs < stepMs) fail('overallMs 不能小于 stepMs');
  bounded(raw.maxCommandOutputBytes, P07_ACCEPT_MIN_OUTPUT_BYTES, P07_ACCEPT_MAX_OUTPUT_BYTES, 'maxCommandOutputBytes');
  const fullRegression = object(raw.fullRegression, 'fullRegression'); keys(fullRegression, ['defaultEnabled', 'optInFlag', 'command', 'reason'], 'fullRegression');
  if (fullRegression.defaultEnabled !== false || fullRegression.optInFlag !== '--full-regression') fail('全仓历史回归必须关闭默认开关并使用显式 --full-regression');
  exactStrings(fullRegression.command, ['npm', 'test'], 'fullRegression.command');
  if (typeof fullRegression.reason !== 'string' || fullRegression.reason.length === 0) fail('fullRegression.reason 必须说明显式开关原因');
  const usageSources = strings(raw.usageSources, 'usageSources');
  if (new Set(usageSources).size !== usageSources.length || !usageSources.includes('runtime-usage') || !usageSources.includes('command-output') || !usageSources.includes('manual-record') || !usageSources.includes('not_run')) fail('usageSources 必须包含稳定的用量来源分类');
  const plan = object(raw.plan, 'plan'); keys(plan, ['phaseId', 'stepId', 'title', 'scope', 'version', 'contractDoc'], 'plan');
  for (const key of ['phaseId', 'stepId', 'title', 'scope', 'version'] as const) if (typeof plan[key] !== 'string' || (plan[key] as string).length === 0) fail(`plan.${key} 必须是非空字符串`);
  const contractDoc = relativePath(plan.contractDoc, 'plan.contractDoc');
  return { configVersion: P07_ACCEPT_CONFIG_VERSION, checklist, reportRoot, requiredChecks: [...P07_REQUIRED_CHECK_IDS], toolchain: P07_TOOLCHAIN, timeouts: { stepMs, overallMs }, maxCommandOutputBytes: raw.maxCommandOutputBytes as number, fakeIdentity: P07_FAKE_IDENTITY, tempResources: P07_TEMP_RESOURCES, executionPolicy: P07_EXECUTION_POLICY, livePolicy: P07_LIVE_POLICY, reportScope: P07_REPORT_SCOPE, engineeringChecks: P07_ENGINEERING_CHECKS, verifySemantics: P07_VERIFY_SEMANTICS, modes: P07_MODES, fullRegression: { defaultEnabled: false, optInFlag: '--full-regression', command: ['npm', 'test'], reason: fullRegression.reason as string }, usageSources, plan: { phaseId: plan.phaseId as string, stepId: plan.stepId as string, title: plan.title as string, scope: plan.scope as string, version: plan.version as string, contractDoc } };
}

export type P07EntryContract = {
  readonly schemaVersion: 1;
  readonly phase: 'P07';
  readonly stepOrder: readonly string[];
  readonly trustedIndexRoot: string;
  readonly requiredFeatures: readonly string[];
  readonly prerequisites: { readonly missingBehavior: 'blocked-not-run'; readonly placeholderAllowed: false; readonly commitAncestryRequired: true };
  readonly defaultExecution: { readonly mode: 'phase'; readonly network: 'denied'; readonly llmCalls: false; readonly fullRegression: false; readonly verifyChecksOnly: true };
  readonly modes: typeof P07_MODES;
  readonly verify: typeof P07_VERIFY_SEMANTICS;
  readonly explicitOptions: { readonly fullRegression: '--full-regression'; readonly manual: '--manual-record' };
  readonly evidence: { readonly requiredFields: readonly string[]; readonly statuses: readonly string[]; readonly notRunCountsAsPassed: false };
  readonly toolchain: { readonly node: string; readonly npm: string; readonly platform: string; readonly defaultConcurrency: number };
  readonly budget: { readonly stepMs: number; readonly overallMs: number; readonly bounded: true };
};

export function validateP07EntryContract(value: unknown): P07EntryContract {
  const raw = object(value, 'entry'); keys(raw, ENTRY_KEYS, 'entry');
  if (raw.schemaVersion !== P07_ENTRY_SCHEMA_VERSION || raw.phase !== 'P07') fail('入口契约版本或阶段不匹配');
  exactStrings(raw.stepOrder, P07_ENTRY_STEP_ORDER, 'stepOrder');
  const trustedIndexRoot = relativePath(raw.trustedIndexRoot, 'trustedIndexRoot');
  exactStrings(raw.requiredFeatures, P07_PREREQUISITE_FEATURES, 'requiredFeatures');
  const prerequisites = object(raw.prerequisites, 'prerequisites'); keys(prerequisites, ['missingBehavior', 'placeholderAllowed', 'commitAncestryRequired'], 'prerequisites');
  if (prerequisites.missingBehavior !== 'blocked-not-run') fail('前序 Feature 缺失必须记为阻塞/not_run');
  if (prerequisites.placeholderAllowed !== false) fail('不得允许占位实现满足前置门槛');
  if (prerequisites.commitAncestryRequired !== true) fail('前序提交必须核验祖先关系');
  const defaultExecution = object(raw.defaultExecution, 'defaultExecution'); keys(defaultExecution, ['mode', 'network', 'llmCalls', 'fullRegression', 'verifyChecksOnly'], 'defaultExecution');
  same(defaultExecution, { mode: 'phase', network: 'denied', llmCalls: false, fullRegression: false, verifyChecksOnly: true }, 'defaultExecution');
  const modes = object(raw.modes, 'modes'); keys(modes, ['default', 'full'], 'modes');
  same(modes, P07_MODES, 'modes');
  const verify = object(raw.verify, 'verify');
  same(verify, P07_VERIFY_SEMANTICS, 'verify');
  const explicitOptions = object(raw.explicitOptions, 'explicitOptions'); keys(explicitOptions, ['fullRegression', 'manual'], 'explicitOptions');
  same(explicitOptions, { fullRegression: '--full-regression', manual: '--manual-record' }, 'explicitOptions');
  const evidence = object(raw.evidence, 'evidence'); keys(evidence, ['requiredFields', 'statuses', 'notRunCountsAsPassed'], 'evidence');
  exactStrings(evidence.requiredFields, P07_ENTRY_EVIDENCE_REQUIRED_FIELDS, 'evidence.requiredFields');
  exactStrings(evidence.statuses, P07_REPORT_STATUSES, 'evidence.statuses');
  if (evidence.notRunCountsAsPassed !== false) fail('not_run 不得计为通过');
  const toolchain = object(raw.toolchain, 'toolchain'); keys(toolchain, ['node', 'npm', 'platform', 'defaultConcurrency'], 'toolchain');
  if (toolchain.node !== P07_TOOLCHAIN.node || toolchain.npm !== P07_TOOLCHAIN.npm || toolchain.platform !== P07_TOOLCHAIN.platform || toolchain.defaultConcurrency !== P07_TOOLCHAIN.defaultConcurrency) fail('入口工具链必须与冻结工具链一致');
  const budget = object(raw.budget, 'budget'); keys(budget, ['stepMs', 'overallMs', 'bounded'], 'budget');
  const stepMs = bounded(budget.stepMs, P07_ACCEPT_MIN_TIMEOUT_MS, P07_ACCEPT_MAX_TIMEOUT_MS, 'budget.stepMs');
  const overallMs = bounded(budget.overallMs, P07_ACCEPT_MIN_TIMEOUT_MS, P07_ACCEPT_MAX_OVERALL_MS, 'budget.overallMs');
  if (overallMs < stepMs) fail('budget.overallMs 不能小于 budget.stepMs');
  if (budget.bounded !== true) fail('执行预算必须为有限值');
  return {
    schemaVersion: P07_ENTRY_SCHEMA_VERSION, phase: 'P07', stepOrder: [...P07_ENTRY_STEP_ORDER], trustedIndexRoot,
    requiredFeatures: [...P07_PREREQUISITE_FEATURES], prerequisites: { missingBehavior: 'blocked-not-run', placeholderAllowed: false, commitAncestryRequired: true },
    defaultExecution: { mode: 'phase', network: 'denied', llmCalls: false, fullRegression: false, verifyChecksOnly: true },
    modes: P07_MODES, verify: P07_VERIFY_SEMANTICS, explicitOptions: { fullRegression: '--full-regression', manual: '--manual-record' },
    evidence: { requiredFields: [...P07_ENTRY_EVIDENCE_REQUIRED_FIELDS], statuses: [...P07_REPORT_STATUSES], notRunCountsAsPassed: false },
    toolchain: { node: P07_TOOLCHAIN.node, npm: P07_TOOLCHAIN.npm, platform: P07_TOOLCHAIN.platform, defaultConcurrency: P07_TOOLCHAIN.defaultConcurrency },
    budget: { stepMs, overallMs, bounded: true },
  };
}

function parseJsonFile(path: string, label: string): unknown {
  if (!existsSync(path)) fail(`${label}不存在：${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { fail(`${label}不是有效 JSON：${String(error)}`); }
}
export function loadP07Checklist(path = P07_CHECKLIST_PATH): P07Checklist { return validateP07Checklist(parseJsonFile(path, '清单')); }
export function loadP07AcceptanceConfig(path: string): P07AcceptanceConfig { return validateP07AcceptanceConfig(parseJsonFile(path, '配置')); }
export function loadP07EntryContract(path = P07_ENTRY_PATH): P07EntryContract { return validateP07EntryContract(parseJsonFile(path, '入口契约')); }

export function summarizeP07Checklist(checklist: P07Checklist): { required: number; deferred: number; byExecution: Record<P07ExecutionType, number>; byFeature: Record<string, number>; designIndexCoverage: Record<P07DesignIndex, number> } {
  const byExecution = Object.fromEntries(P07_EXECUTION_TYPES.map(type => [type, checklist.items.filter(item => item.execution === type).length])) as Record<P07ExecutionType, number>;
  const byFeature = Object.fromEntries(P07_PREREQUISITE_FEATURES.map(feature => [feature, checklist.items.filter(item => item.features.includes(feature)).length]));
  const required = checklist.items.filter(item => item.group !== 'deferred');
  const designIndexCoverage = Object.fromEntries(P07_DESIGN_INDEXES.map(designIndex => [designIndex, required.filter(item => item.designIndexes.includes(designIndex)).length])) as Record<P07DesignIndex, number>;
  return { required: required.length, deferred: checklist.items.filter(item => item.group === 'deferred').length, byExecution, byFeature, designIndexCoverage };
}

/** 键序无关的稳定序列化，用于清单/模式摘要。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 清单内容摘要：内容或结构变化即变化，报告以此追溯清单版本。 */
export function digestP07Checklist(checklist: P07Checklist): string {
  const material = {
    checklistVersion: checklist.checklistVersion,
    phase: checklist.phase,
    layers: checklist.layers,
    executionTypes: checklist.executionTypes,
    evidenceCategories: checklist.evidenceCategories,
    countRule: checklist.countRule,
    items: checklist.items,
  };
  return createHash('sha256').update(canonicalJson(material)).digest('hex');
}

/** 执行模式摘要：默认阶段模式与显式全量模式的范围/输入摘要必须不同。 */
export function digestP07ExecutionMode(mode: 'default' | 'full'): string {
  const material = { phase: 'P07', mode, definition: P07_MODES[mode], verifySemantics: P07_VERIFY_SEMANTICS };
  return createHash('sha256').update(canonicalJson(material)).digest('hex');
}

/** 有限预算校验：非法预算（0、负数、非整数、越界、总体小于单步）一律拒绝。 */
export function validateP07Budget(timeouts: { stepMs: unknown; overallMs: unknown }): { stepMs: number; overallMs: number } {
  const stepMs = bounded(timeouts.stepMs, P07_ACCEPT_MIN_TIMEOUT_MS, P07_ACCEPT_MAX_TIMEOUT_MS, 'stepMs');
  const overallMs = bounded(timeouts.overallMs, P07_ACCEPT_MIN_TIMEOUT_MS, P07_ACCEPT_MAX_OVERALL_MS, 'overallMs');
  if (overallMs < stepMs) fail('overallMs 不能小于 stepMs');
  return { stepMs, overallMs };
}

/* ------------------------------------------------------------------ *
 * 前置门槛：P07-1～P07-4 交付证据、公开接口与提交祖先关系
 * ------------------------------------------------------------------ */

export type P07PrerequisiteInput = {
  readonly feature: string;
  readonly commit: string;
  readonly delivered: boolean;
  readonly interfacesSatisfied: boolean;
  /** 交付证据引用（如阶段报告/Feature 报告路径或摘要）；空即视为证据缺失。 */
  readonly deliveryEvidence: readonly string[];
  /** 已核验的公开接口清单；空即视为公开接口未核验。 */
  readonly publicInterfaces: readonly string[];
  /** 前序 commit 是否为受测 HEAD 的祖先（由入口用 git merge-base 核验后传入）。 */
  readonly ancestorOfHead: boolean;
};
export type P07PrerequisiteBlockerCode =
  | 'not_delivered' | 'interfaces_unsatisfied' | 'invalid_commit' | 'evidence_missing' | 'interfaces_missing' | 'not_ancestor';
export type P07PrerequisiteEvaluation = {
  readonly status: 'satisfied' | 'blocked';
  readonly resultStatus: 'pass' | 'not_run';
  readonly blockedFeatures: readonly string[];
  readonly blockers: readonly { readonly feature: string; readonly code: P07PrerequisiteBlockerCode; readonly detail: string }[];
  readonly reason: string;
};

export function evaluateP07Prerequisites(inputs: readonly P07PrerequisiteInput[]): P07PrerequisiteEvaluation {
  const byFeature = new Map<string, P07PrerequisiteInput>();
  for (const input of inputs) {
    if (typeof input.feature !== 'string' || !P07_PREREQUISITE_FEATURES.includes(input.feature as P07PrerequisiteFeature)) fail(`前置输入含未知 Feature：${String(input.feature)}`);
    if (byFeature.has(input.feature)) fail(`前置输入含重复 Feature：${input.feature}`);
    if (typeof input.commit !== 'string') fail(`前置输入 ${input.feature}.commit 必须是字符串`);
    if (typeof input.delivered !== 'boolean' || typeof input.interfacesSatisfied !== 'boolean' || typeof input.ancestorOfHead !== 'boolean') fail(`前置输入 ${input.feature} 的布尔字段非法`);
    if (!Array.isArray(input.deliveryEvidence) || !Array.isArray(input.publicInterfaces) ||
        input.deliveryEvidence.some(entry => typeof entry !== 'string' || entry.length === 0) ||
        input.publicInterfaces.some(entry => typeof entry !== 'string' || entry.length === 0)) fail(`前置输入 ${input.feature} 的证据/接口清单必须是非空字符串数组`);
    byFeature.set(input.feature, input);
  }
  const blockers: { feature: string; code: P07PrerequisiteBlockerCode; detail: string }[] = [];
  for (const feature of P07_PREREQUISITE_FEATURES) {
    const input = byFeature.get(feature);
    if (!input) { blockers.push({ feature, code: 'not_delivered', detail: '缺少前置输入，按未交付处理' }); continue; }
    if (input.delivered !== true) blockers.push({ feature, code: 'not_delivered', detail: 'delivered 不为 true' });
    if (input.interfacesSatisfied !== true) blockers.push({ feature, code: 'interfaces_unsatisfied', detail: '公开接口不满足（疑似占位实现）' });
    if (!/^[a-f0-9]{40}$/.test(input.commit)) blockers.push({ feature, code: 'invalid_commit', detail: 'commit 不是 40 位小写十六进制 SHA' });
    if (input.deliveryEvidence.length === 0) blockers.push({ feature, code: 'evidence_missing', detail: '缺少交付证据引用' });
    if (input.publicInterfaces.length === 0) blockers.push({ feature, code: 'interfaces_missing', detail: '缺少已核验公开接口清单' });
    if (input.ancestorOfHead !== true) blockers.push({ feature, code: 'not_ancestor', detail: '前序提交不是受测 HEAD 的祖先' });
  }
  if (blockers.length === 0) {
    return { status: 'satisfied', resultStatus: 'pass', blockedFeatures: [], blockers: [], reason: '前序 P07-1～P07-4 均已交付、接口满足且提交祖先关系成立' };
  }
  const blockedFeatures = [...new Set(blockers.map(blocker => blocker.feature))];
  return {
    status: 'blocked',
    resultStatus: 'not_run',
    blockedFeatures,
    blockers,
    reason: `前序 Feature 未交付、证据缺失、接口不满足或祖先关系不成立：${blockedFeatures.join(',')}；相关步骤记 not_run，不得以占位实现或补库放行`,
  };
}

/* ------------------------------------------------------------------ *
 * 严格三态聚合
 * ------------------------------------------------------------------ */

export type P07CheckResult = { readonly checkId: string; readonly status: P07ReportStatus; readonly executionMode: 'fake' | 'manual'; readonly evidence?: readonly string[]; readonly manualStatus?: 'pending' | 'confirmed' | 'rejected'; readonly reason?: string };
export type P07AggregatedCheck = P07FrozenItem & { readonly status: P07ReportStatus; readonly reason?: string; readonly executionMode?: string };
export type P07Aggregate = { readonly checks: readonly P07AggregatedCheck[]; readonly counts: { readonly pass: number; readonly fail: number; readonly not_run: number }; readonly conclusion: 'pass' | 'fail' };
export function aggregateP07CheckResults(checklist: P07Checklist, results: readonly P07CheckResult[]): P07Aggregate {
  const byId = new Map<string, P07CheckResult>();
  for (const result of results) { if (!ITEM_BY_ID.has(result.checkId)) throw new P07AcceptError('invalid_config', `结果含未知检查：${result.checkId}`); if (byId.has(result.checkId)) throw new P07AcceptError('invalid_config', `结果含重复检查：${result.checkId}`); byId.set(result.checkId, result); }
  const checks = checklist.items.map(item => {
    const result = byId.get(item.id);
    if (!result) return { ...item, status: 'not_run' as const, reason: '未提供结果' };
    if (result.status === 'not_run') return { ...item, status: 'not_run' as const, reason: result.reason ?? '执行类别未运行', executionMode: result.executionMode };
    if (result.status === 'fail') return { ...item, status: 'fail' as const, reason: result.reason ?? '检查失败', executionMode: result.executionMode };
    const requiredEvidence = new Set(item.evidence);
    const actualEvidence = new Set(result.evidence ?? []);
    const missingEvidence = [...requiredEvidence].filter(category => !actualEvidence.has(category));
    const modeValid = (item.execution === 'offline' && result.executionMode === 'fake') || (item.execution === 'manual' && result.executionMode === 'manual' && result.manualStatus === 'confirmed');
    const pending = item.execution === 'manual' && result.manualStatus !== 'confirmed';
    if (missingEvidence.length > 0 || !modeValid || pending) return { ...item, status: 'fail' as const, reason: missingEvidence.length > 0 ? `缺少证据：${missingEvidence.join(',')}` : pending ? '负责人仍为 pending/rejected' : `执行类别不匹配：${result.executionMode}`, executionMode: result.executionMode };
    return { ...item, status: 'pass' as const, executionMode: result.executionMode };
  });
  const requiredChecks = checks.filter(check => check.group !== 'deferred');
  const counts = { pass: requiredChecks.filter(check => check.status === 'pass').length, fail: requiredChecks.filter(check => check.status === 'fail').length, not_run: requiredChecks.filter(check => check.status === 'not_run').length };
  const conclusion = requiredChecks.every(check => check.status === 'pass') ? 'pass' : 'fail';
  return { checks, counts, conclusion };
}

// Compatibility surface for later P07-5 tasks (report/entry).
export type P07ChecklistItem = P07FrozenItem;
export const P07_ACCEPT_MIN_TIMEOUT_MS = 1_000;
export const P07_ACCEPT_MAX_TIMEOUT_MS = 7_200_000;
export const P07_ACCEPT_MAX_OVERALL_MS = 14_400_000;
export const P07_ACCEPT_MIN_OUTPUT_BYTES = 1_024;
export const P07_ACCEPT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
