import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const P05_CHECKLIST_VERSION = 1;
export const P05_ACCEPT_CONFIG_VERSION = 1;
export const P05_CHECKLIST_PATH = 'acceptance/p05.checklist.json';
export const P05_ACCEPT_CONFIG_PATH = 'acceptance/p05.config.json';

export const P05_FEATURES = ['P05-1', 'P05-2', 'P05-3', 'P05-4', 'P05-5', 'P05-6', 'P05-7', 'P05-8', 'P05-9'] as const;
export const P05_LAYERS = ['unit', 'feature-integration', 'phase-acceptance'] as const;
export type P05Layer = (typeof P05_LAYERS)[number];
export const P05_EXECUTION_TYPES = ['offline', 'live', 'manual', 'postponed'] as const;
export type P05ExecutionType = (typeof P05_EXECUTION_TYPES)[number];
export const P05_EVIDENCE_CATEGORIES = [
  'command-exit', 'sqlite', 'git', 'process', 'artifact', 'report', 'manifest',
  'live', 'manual', 'sha', 'usage', 'cleanup',
] as const;
export type P05EvidenceCategory = (typeof P05_EVIDENCE_CATEGORIES)[number];
export const P05_FR_IDS = ['FR-1', 'FR-2', 'FR-3', 'FR-4'] as const;
export const P05_REPORT_STATUSES = ['pass', 'fail', 'not_run'] as const;
export type P05ReportStatus = (typeof P05_REPORT_STATUSES)[number];

export const P05_COUNT_RULE =
  '必需项全部 pass 才算通过；not_run 和人工 pending 不计入通过；deferred 项不参与通过计数；覆盖按必需断言判定，不按测试数量判断';

export const P05_TOOLCHAIN = {
  packageManager: 'npm@10.9.3', node: '22.19.0', npm: '10.9.3', lockfile: 'package-lock.json',
} as const;
export const P05_FAKE_IDENTITY = {
  provider: 'fake-provider', model: 'fake-model', realModel: false, network: 'denied',
} as const;
export const P05_TEMP_RESOURCES = {
  git: 'temp', sqlite: 'temp', dataRoot: 'temp', home: 'temp', processes: 'owned-only', reusePrevious: false,
} as const;
export const P05_REPORT_SCOPE = {
  statuses: ['pass', 'fail', 'not_run'], includeEvidenceHash: true, includeManualChecklist: true,
  notRunCountsAsPassed: false, deferredCountsAsPassed: false,
} as const;
export const P05_EXECUTION_POLICY = {
  offline: { runtime: 'fake-or-scripted', network: 'denied', llmCalls: false },
  live: { authorizationRequired: true, boundedRequestsRequired: true, credentialsInEvidence: false },
  manual: { ownerConfirmationRequired: true, machineMaySign: false },
  notRun: { countsAsPassed: false },
} as const;

export type P05ItemGroup = 'fr' | 'scenario' | 'live' | 'manual' | 'deferred';
export type P05FrozenItem = {
  readonly id: string;
  readonly group: P05ItemGroup;
  readonly title: string;
  readonly layer: P05Layer;
  readonly execution: P05ExecutionType;
  readonly features: readonly string[];
  readonly scenarioIds: readonly string[];
  readonly fr: readonly string[];
  readonly acceptanceRefs: readonly string[];
  readonly assertions: readonly string[];
  readonly evidence: readonly P05EvidenceCategory[];
};

const FR_ITEMS: readonly P05FrozenItem[] = [
  {
    id: 'P05-FR1-OFFLINE-CLOSURE', group: 'fr', title: 'FR-1 离线闭环与证据身份', layer: 'phase-acceptance', execution: 'offline',
    features: [...P05_FEATURES], scenarioIds: ['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09'], fr: ['FR-1'], acceptanceRefs: ['FR-1', 'AC-1', 'AC-3'],
    assertions: ['阶段入口使用 FakeRuntime/脚本化 Runtime，不调用模型或网络，并逐项绑定场景、输入摘要和受测完整 SHA', 'SQLite、Git、文件、进程和清理事实由真实临时资源断言，失败、缺证据和 not_run 保留原状'],
    evidence: ['command-exit', 'artifact', 'manifest', 'sha', 'usage', 'cleanup'],
  },
  {
    id: 'P05-FR2-CONCURRENCY-INTEGRATION', group: 'fr', title: 'FR-2 并发、依赖与确定性集成', layer: 'phase-acceptance', execution: 'offline',
    features: ['P05-2', 'P05-3', 'P05-4', 'P05-5', 'P05-6', 'P05-7', 'P05-9'], scenarioIds: ['I02', 'I03', 'I05', 'I07', 'I08'], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'AC-1', 'AC-3'],
    assertions: ['A/B 只在批准并发和资源允许时重叠，C 在固定前置成果和组合验证前保持 blocked/pending', 'Batch 范围、预算、锁、Git 集成顺序和叶子汇总均以持久事实核对，追加 Feature 使用新 Batch'],
    evidence: ['sqlite', 'git', 'process', 'artifact', 'sha', 'usage'],
  },
  {
    id: 'P05-FR3-FAULT-RECOVERY', group: 'fr', title: 'FR-3 故障、恢复与有界修复', layer: 'phase-acceptance', execution: 'offline',
    features: ['P05-4', 'P05-5', 'P05-7', 'P05-8'], scenarioIds: ['I04', 'I05', 'I06'], fr: ['FR-3'], acceptanceRefs: ['FR-3', 'AC-1', 'AC-3'],
    assertions: ['重复信号、崩溃、租约过期、迟到结果、取消和未确认停止分别保留 owner fencing、资源和进程证据', 'Git 冲突修复只使用授权范围和父预算，失败或预算耗尽阻塞并保留现场，不由模型自报成功'],
    evidence: ['sqlite', 'git', 'process', 'artifact', 'usage', 'cleanup'],
  },
  {
    id: 'P05-FR4-REPORT-MANUAL-GATE', group: 'fr', title: 'FR-4 报告完整性与人工放行', layer: 'phase-acceptance', execution: 'manual',
    features: [...P05_FEATURES], scenarioIds: ['I09'], fr: ['FR-4'], acceptanceRefs: ['FR-4', 'AC-2', 'AC-4'],
    assertions: ['报告逐项记录状态、实际命令、退出码、耗时、证据哈希、受测完整 SHA、用量来源、清理事实和未执行原因', '工程/集成、live 证据和负责人确认缺一不可；机器成功不能覆盖 manual pending 或 rejected'],
    evidence: ['report', 'manual', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const SCENARIO_ITEMS: readonly P05FrozenItem[] = [
  {
    id: 'P05-I01-PLANNING-APPROVAL', group: 'scenario', title: 'I01 一次性规划候选批准', layer: 'feature-integration', execution: 'offline',
    features: ['P05-1', 'P05-2', 'P05-3'], scenarioIds: ['I01'], fr: ['FR-1', 'FR-2'], acceptanceRefs: ['I01', 'P05-1', 'P05-2', 'P05-3'],
    assertions: ['一次规划只产生一份冻结候选，未经批准不可执行；重复、跨项目和环依赖被拒绝并记录原因', '候选、批准、Task 导入和固定 Batch 的身份与 digest 保持一致'], evidence: ['sqlite', 'artifact', 'command-exit', 'sha', 'usage'],
  },
  {
    id: 'P05-I02-AB-CONVERGENCE', group: 'scenario', title: 'I02 A/B 并发与 C 集成前阻塞', layer: 'feature-integration', execution: 'offline',
    features: ['P05-4', 'P05-6', 'P05-7'], scenarioIds: ['I02'], fr: ['FR-2'], acceptanceRefs: ['I02', 'P05-4', 'P05-6', 'P05-7'],
    assertions: ['A/B 在共同基线保留独立成果，C 在两者成果、合并顺序和组合验证证据齐全前保持 blocked/pending', '输入 SHA、目标基线或策略漂移会使旧集成证据失效'], evidence: ['sqlite', 'git', 'artifact', 'sha', 'usage'],
  },
  {
    id: 'P05-I03-RESOURCE-MUTEX', group: 'scenario', title: 'I03 共享资源互斥', layer: 'feature-integration', execution: 'offline',
    features: ['P05-4', 'P05-5'], scenarioIds: ['I03'], fr: ['FR-2', 'FR-3'], acceptanceRefs: ['I03', 'P05-4', 'P05-5'],
    assertions: ['共享项目、迁移、契约或工作区资源按统一顺序互斥，独立资源仍可推进且不死锁', '锁竞争等待不启动越权 Runner、不重复扣预算，租约和 owner 事实可解释'], evidence: ['sqlite', 'process', 'artifact', 'usage', 'cleanup'],
  },
  {
    id: 'P05-I04-RECOVERY-FENCING', group: 'scenario', title: 'I04 崩溃、取消与迟到结果恢复', layer: 'feature-integration', execution: 'offline',
    features: ['P05-4', 'P05-5', 'P05-7'], scenarioIds: ['I04'], fr: ['FR-3'], acceptanceRefs: ['I04', 'P05-4', 'P05-5', 'P05-7'],
    assertions: ['重复派发、重启补扫、进程崩溃和租约过期不重复启动同一 Feature；旧 owner 迟到结果不能覆盖或释放新资源', '取消、暂停和未确认停止分别保留状态、进程、工作区和清理事实'], evidence: ['sqlite', 'process', 'artifact', 'usage', 'cleanup'],
  },
  {
    id: 'P05-I05-GIT-INTEGRATION', group: 'scenario', title: 'I05 确定性 Git 集成与冲突留场', layer: 'feature-integration', execution: 'offline',
    features: ['P05-6', 'P05-7'], scenarioIds: ['I05'], fr: ['FR-2', 'FR-3'], acceptanceRefs: ['I05', 'P05-6', 'P05-7'],
    assertions: ['无冲突时组合工作区包含全部固定前置成果并经验证；冲突、验证失败和回执前崩溃均保留可恢复意图与现场', '重复集成按 operationId 幂等，不以漂移 HEAD 或未核对的文件状态放行'], evidence: ['git', 'sqlite', 'artifact', 'sha', 'usage', 'cleanup'],
  },
  {
    id: 'P05-I06-BOUNDED-REPAIR', group: 'scenario', title: 'I06 有界 GitAgent 冲突修复', layer: 'feature-integration', execution: 'offline',
    features: ['P05-8'], scenarioIds: ['I06'], fr: ['FR-3'], acceptanceRefs: ['I06', 'P05-8'],
    assertions: ['修复 Runtime 只能使用保存的冲突上下文和授权写入范围，并受父预算、取消和次数上限约束', '越界、无效修复、预算耗尽或停止不确定均阻塞并保留候选、日志和资源'], evidence: ['git', 'sqlite', 'process', 'artifact', 'usage', 'cleanup'],
  },
  {
    id: 'P05-I07-LEAF-DELIVERY', group: 'scenario', title: 'I07 并行叶子汇总与交付', layer: 'feature-integration', execution: 'offline',
    features: ['P05-9'], scenarioIds: ['I07'], fr: ['FR-2', 'FR-4'], acceptanceRefs: ['I07', 'P05-9'],
    assertions: ['无共同后继的叶子全部纳入 Batch/Phase 汇总，Task 完成、Feature 交付、集成通过和 Phase 批准分层记录', '缺叶子、缺验证或缺人工批准不得生成可放行交付结论'], evidence: ['sqlite', 'git', 'report', 'artifact', 'sha', 'usage'],
  },
  {
    id: 'P05-I08-APPEND-BATCH', group: 'scenario', title: 'I08 追加 Feature 与新 Batch', layer: 'feature-integration', execution: 'offline',
    features: ['P05-2', 'P05-3', 'P05-9'], scenarioIds: ['I08'], fr: ['FR-2'], acceptanceRefs: ['I08', 'P05-2', 'P05-3', 'P05-9'],
    assertions: ['活动 Batch 的范围、策略和累计预算冻结，追加 Feature 不扩大旧 Batch 或隐式创建成员', '新 Feature 只能通过显式新 Batch 进入执行，旧 Batch 的结果和计数保持不变'], evidence: ['sqlite', 'artifact', 'sha', 'usage'],
  },
  {
    id: 'P05-I09-INPUT-BUDGET-INTEGRITY', group: 'scenario', title: 'I09 输入漂移、预算耗尽与验收失败关闭', layer: 'phase-acceptance', execution: 'offline',
    features: [...P05_FEATURES], scenarioIds: ['I09'], fr: ['FR-1', 'FR-3', 'FR-4'], acceptanceRefs: ['I09', 'P05-10'],
    assertions: ['输入摘要、受测 SHA、预算、报告身份或证据哈希不匹配时 fail-closed，不覆盖既有成功证据', '步骤错误、超时、清理不确定和证据写入失败保留前序结果、现场及 not_run 原因'], evidence: ['command-exit', 'artifact', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const LIVE_ITEMS: readonly P05FrozenItem[] = [
  {
    id: 'P05-LIVE-GIT-AGENT-AUTH', group: 'live', title: 'P05 live GitAgent 授权与有界请求', layer: 'phase-acceptance', execution: 'live',
    features: ['P05-8'], scenarioIds: ['I06'], fr: ['FR-3'], acceptanceRefs: ['FR-3', 'I06', 'P05-8'],
    assertions: ['只有负责人明确授权的临时 Git 项目、provider/model、请求预算和写入范围才能发起 live 调用', '缺失授权、认证或真实证据保持 not_run/failed，离线 Fake 结果不能折算 live 通过'], evidence: ['live', 'git', 'process', 'command-exit', 'sha', 'usage', 'cleanup'],
  },
];

const MANUAL_ITEMS: readonly P05FrozenItem[] = [
  {
    id: 'P05-MANUAL-OWNER-GATE', group: 'manual', title: 'P05 负责人 macOS 操作与阶段放行', layer: 'phase-acceptance', execution: 'manual',
    features: [...P05_FEATURES], scenarioIds: ['I09'], fr: ['FR-4'], acceptanceRefs: ['FR-4', 'AC-2', 'AC-4'],
    assertions: ['负责人按 macOS 清单记录完整 SHA、实际命令、退出码、用量来源、清理事实和未执行项，并明确确认时间与结论', 'pending/rejected、缺签署、SHA 不匹配或 live not_run 时阶段结论不能通过'], evidence: ['manual', 'report', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const DEFERRED_ITEMS: readonly P05FrozenItem[] = [
  {
    id: 'P05-POST-FULL-HISTORY-REGRESSION', group: 'deferred', title: '后置：全仓历史回归', layer: 'phase-acceptance', execution: 'postponed',
    features: [...P05_FEATURES], scenarioIds: ['I09'], fr: ['FR-4'], acceptanceRefs: ['FR-4', 'FULL-REGRESSION'],
    assertions: ['全仓历史回归只能由显式 --full-regression 选项或发布验收发起，不属于默认 P05 阶段门禁', '未运行全仓回归报告为 not_run，不计入阶段通过'], evidence: ['command-exit', 'report', 'manifest'],
  },
];

export const P05_FROZEN_ITEMS: readonly P05FrozenItem[] = [
  ...FR_ITEMS, ...SCENARIO_ITEMS, ...LIVE_ITEMS, ...MANUAL_ITEMS, ...DEFERRED_ITEMS,
];
export const P05_REQUIRED_CHECK_IDS = P05_FROZEN_ITEMS.filter(item => item.group !== 'deferred').map(item => item.id);
export const P05_DEFERRED_IDS = P05_FROZEN_ITEMS.filter(item => item.group === 'deferred').map(item => item.id);
const ITEM_BY_ID = new Map(P05_FROZEN_ITEMS.map(item => [item.id, item]));

const CHECKLIST_KEYS = ['checklistVersion', 'phase', 'layers', 'executionTypes', 'evidenceCategories', 'countRule', 'items'] as const;
const ITEM_KEYS = ['id', 'group', 'title', 'layer', 'execution', 'features', 'scenarioIds', 'fr', 'acceptanceRefs', 'assertions', 'evidence'] as const;
const CONFIG_KEYS = ['configVersion', 'checklist', 'reportRoot', 'requiredChecks', 'toolchain', 'timeouts', 'maxCommandOutputBytes', 'fakeIdentity', 'tempResources', 'executionPolicy', 'reportScope', 'fullRegression', 'usageSources', 'plan'] as const;
const CREDENTIAL_KEY = /(?:authorization|auth|token|password|passwd|secret|credential|cookie|api[_-]?key)/i;
const BUSINESS_KEY = /^(?:schemaVersions|migrations?|settings|database|productConfig|businessConfig)$/i;
const ID_PATTERN = /^P05-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const REF_PATTERN = /^(?:FR-[1-4]|I0[1-9]|P05-(?:[1-9]|10)|AC-[1-4]|FULL-REGRESSION)$/;

export type P05AcceptErrorKind = 'invalid_config';
export class P05AcceptError extends Error {
  readonly kind: P05AcceptErrorKind;
  readonly detail?: string;
  constructor(kind: P05AcceptErrorKind, message: string, detail?: string) { super(message); this.name = 'P05AcceptError'; this.kind = kind; this.detail = detail; }
}
function fail(message: string, detail?: string): never { throw new P05AcceptError('invalid_config', message, detail); }
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
function stringMap(value: unknown, label: string): Record<string, unknown> { return object(value, label); }

function validateItem(rawValue: unknown, index: number): void {
  const raw = object(rawValue, `items[${index}]`);
  keys(raw, ITEM_KEYS, `items[${index}]`);
  for (const key of ITEM_KEYS) if (!(key in raw)) fail(`items[${index}] 缺少字段：${key}`);
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) fail(`items[${index}].id 非法`);
  const expected = ITEM_BY_ID.get(raw.id);
  if (!expected) fail(`items[${index}] 含未知检查：${raw.id}`);
  if (raw.group !== expected.group || raw.title !== expected.title || raw.layer !== expected.layer || raw.execution !== expected.execution) fail(`检查 ${raw.id} 的身份或执行类别被改写`);
  exactStrings(raw.features, expected.features, `${raw.id}.features`);
  exactStrings(raw.scenarioIds, expected.scenarioIds, `${raw.id}.scenarioIds`);
  const fr = exactStrings(raw.fr, expected.fr, `${raw.id}.fr`);
  if (fr.some(value => !P05_FR_IDS.includes(value as (typeof P05_FR_IDS)[number]))) fail(`${raw.id}.fr 含未知 FR`);
  const refs = exactStrings(raw.acceptanceRefs, expected.acceptanceRefs, `${raw.id}.acceptanceRefs`);
  if (refs.some(value => !REF_PATTERN.test(value))) fail(`${raw.id}.acceptanceRefs 含未知引用`);
  exactStrings(raw.assertions, expected.assertions, `${raw.id}.assertions`);
  const evidence = exactStrings(raw.evidence, expected.evidence, `${raw.id}.evidence`);
  if (evidence.some(value => !P05_EVIDENCE_CATEGORIES.includes(value as P05EvidenceCategory))) fail(`${raw.id}.evidence 含未知类别`);
}

export function validateP05Checklist(value: unknown): P05Checklist {
  const raw = object(value, 'checklist');
  keys(raw, CHECKLIST_KEYS, 'checklist');
  if (raw.checklistVersion !== P05_CHECKLIST_VERSION || raw.phase !== 'P05') fail('清单版本或阶段不匹配');
  exactStrings(raw.layers, P05_LAYERS, 'layers');
  exactStrings(raw.executionTypes, P05_EXECUTION_TYPES, 'executionTypes');
  exactStrings(raw.evidenceCategories, P05_EVIDENCE_CATEGORIES, 'evidenceCategories');
  if (raw.countRule !== P05_COUNT_RULE) fail('countRule 被改写');
  if (!Array.isArray(raw.items) || raw.items.length !== P05_FROZEN_ITEMS.length) fail('items 数量与冻结清单不一致');
  const seen = new Set<string>();
  (raw.items as unknown[]).forEach((item, index) => {
    validateItem(item, index);
    const id = (item as { id: string }).id;
    if (seen.has(id)) fail(`检查 ID 重复：${id}`);
    seen.add(id);
    if (id !== P05_FROZEN_ITEMS[index].id) fail(`检查顺序被改写：${id}`);
  });
  return { checklistVersion: P05_CHECKLIST_VERSION, phase: 'P05', layers: [...P05_LAYERS], executionTypes: [...P05_EXECUTION_TYPES], evidenceCategories: [...P05_EVIDENCE_CATEGORIES], countRule: P05_COUNT_RULE, items: P05_FROZEN_ITEMS };
}

export type P05FullRegression = { readonly defaultEnabled: false; readonly optInFlag: '--full-regression'; readonly command: readonly string[]; readonly reason: string };
export type P05AcceptanceConfig = {
  readonly configVersion: 1; readonly checklist: string; readonly reportRoot: string; readonly requiredChecks: readonly string[];
  readonly toolchain: typeof P05_TOOLCHAIN; readonly timeouts: { readonly stepMs: number; readonly overallMs: number };
  readonly maxCommandOutputBytes: number; readonly fakeIdentity: typeof P05_FAKE_IDENTITY; readonly tempResources: typeof P05_TEMP_RESOURCES;
  readonly executionPolicy: typeof P05_EXECUTION_POLICY; readonly reportScope: typeof P05_REPORT_SCOPE; readonly fullRegression: P05FullRegression;
  readonly usageSources: readonly string[]; readonly plan: { readonly phaseId: string; readonly stepId: string; readonly title: string; readonly scope: string; readonly version: string; readonly contractDoc: string };
};

export function validateP05AcceptanceConfig(value: unknown): P05AcceptanceConfig {
  const raw = object(value, 'config'); keys(raw, CONFIG_KEYS, 'config');
  if (raw.configVersion !== 1) fail('configVersion 不匹配');
  const checklist = relativePath(raw.checklist, 'checklist');
  const reportRoot = relativePath(raw.reportRoot, 'reportRoot');
  exactStrings(raw.requiredChecks, P05_REQUIRED_CHECK_IDS, 'requiredChecks');
  same(raw.toolchain, P05_TOOLCHAIN, 'toolchain'); same(raw.fakeIdentity, P05_FAKE_IDENTITY, 'fakeIdentity'); same(raw.tempResources, P05_TEMP_RESOURCES, 'tempResources');
  const timeouts = object(raw.timeouts, 'timeouts'); keys(timeouts, ['stepMs', 'overallMs'], 'timeouts');
  const stepMs = bounded(timeouts.stepMs, 1_000, 7_200_000, 'timeouts.stepMs');
  const overallMs = bounded(timeouts.overallMs, 1_000, 14_400_000, 'timeouts.overallMs');
  if (overallMs < stepMs) fail('overallMs 不能小于 stepMs');
  bounded(raw.maxCommandOutputBytes, 1_024, 16 * 1024 * 1024, 'maxCommandOutputBytes');
  same(raw.executionPolicy, P05_EXECUTION_POLICY, 'executionPolicy'); same(raw.reportScope, P05_REPORT_SCOPE, 'reportScope');
  const fullRegression = object(raw.fullRegression, 'fullRegression'); keys(fullRegression, ['defaultEnabled', 'optInFlag', 'command', 'reason'], 'fullRegression');
  if (fullRegression.defaultEnabled !== false || fullRegression.optInFlag !== '--full-regression') fail('全仓历史回归必须关闭默认开关并使用显式 --full-regression');
  exactStrings(fullRegression.command, ['npm', 'test'], 'fullRegression.command');
  if (typeof fullRegression.reason !== 'string' || fullRegression.reason.length === 0) fail('fullRegression.reason 必须说明显式开关原因');
  const usageSources = strings(raw.usageSources, 'usageSources');
  if (new Set(usageSources).size !== usageSources.length || !usageSources.includes('runtime-usage') || !usageSources.includes('command-output') || !usageSources.includes('manual-record') || !usageSources.includes('not_run')) fail('usageSources 必须包含稳定的用量来源分类');
  const plan = object(raw.plan, 'plan'); keys(plan, ['phaseId', 'stepId', 'title', 'scope', 'version', 'contractDoc'], 'plan');
  for (const key of ['phaseId', 'stepId', 'title', 'scope', 'version'] as const) if (typeof plan[key] !== 'string' || plan[key].length === 0) fail(`plan.${key} 必须是非空字符串`);
  const contractDoc = relativePath(plan.contractDoc, 'plan.contractDoc');
  return { configVersion: 1, checklist, reportRoot, requiredChecks: [...P05_REQUIRED_CHECK_IDS], toolchain: P05_TOOLCHAIN, timeouts: { stepMs, overallMs }, maxCommandOutputBytes: raw.maxCommandOutputBytes as number, fakeIdentity: P05_FAKE_IDENTITY, tempResources: P05_TEMP_RESOURCES, executionPolicy: P05_EXECUTION_POLICY, reportScope: P05_REPORT_SCOPE, fullRegression: { defaultEnabled: false, optInFlag: '--full-regression', command: ['npm', 'test'], reason: fullRegression.reason as string }, usageSources, plan: { phaseId: plan.phaseId as string, stepId: plan.stepId as string, title: plan.title as string, scope: plan.scope as string, version: plan.version as string, contractDoc } };
}

export type P05Checklist = { readonly checklistVersion: 1; readonly phase: 'P05'; readonly layers: readonly P05Layer[]; readonly executionTypes: readonly P05ExecutionType[]; readonly evidenceCategories: readonly P05EvidenceCategory[]; readonly countRule: string; readonly items: readonly P05FrozenItem[] };
export function loadP05Checklist(path: string): P05Checklist { if (!existsSync(path)) fail(`清单不存在：${path}`); let raw: unknown; try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { fail(`清单不是有效 JSON：${String(error)}`); } return validateP05Checklist(raw); }
export function loadP05AcceptanceConfig(path: string): P05AcceptanceConfig { if (!existsSync(path)) fail(`配置不存在：${path}`); let raw: unknown; try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { fail(`配置不是有效 JSON：${String(error)}`); } return validateP05AcceptanceConfig(raw); }
export function summarizeP05Checklist(checklist: P05Checklist): { required: number; deferred: number; byExecution: Record<P05ExecutionType, number>; byFeature: Record<string, number> } {
  const byExecution = Object.fromEntries(P05_EXECUTION_TYPES.map(type => [type, checklist.items.filter(item => item.execution === type).length])) as Record<P05ExecutionType, number>;
  const byFeature = Object.fromEntries(P05_FEATURES.map(feature => [feature, checklist.items.filter(item => item.features.includes(feature)).length]));
  return { required: checklist.items.filter(item => item.group !== 'deferred').length, deferred: checklist.items.filter(item => item.group === 'deferred').length, byExecution, byFeature };
}

export type P05CheckResult = { readonly checkId: string; readonly status: P05ReportStatus; readonly executionMode: 'fake' | 'live' | 'manual'; readonly evidence?: readonly string[]; readonly manualStatus?: 'pending' | 'confirmed' | 'rejected'; readonly reason?: string };
export type P05AggregatedCheck = P05FrozenItem & { readonly status: P05ReportStatus; readonly reason?: string; readonly executionMode?: string };
export type P05Aggregate = { readonly checks: readonly P05AggregatedCheck[]; readonly counts: { readonly pass: number; readonly fail: number; readonly not_run: number }; readonly conclusion: 'pass' | 'fail' };
export function aggregateP05CheckResults(checklist: P05Checklist, results: readonly P05CheckResult[]): P05Aggregate {
  const byId = new Map<string, P05CheckResult>();
  for (const result of results) { if (!ITEM_BY_ID.has(result.checkId)) throw new P05AcceptError('invalid_config', `结果含未知检查：${result.checkId}`); if (byId.has(result.checkId)) throw new P05AcceptError('invalid_config', `结果含重复检查：${result.checkId}`); byId.set(result.checkId, result); }
  const checks = checklist.items.map(item => {
    const result = byId.get(item.id);
    if (!result) return { ...item, status: 'not_run' as const, reason: '未提供结果' };
    if (result.status === 'not_run') return { ...item, status: 'not_run' as const, reason: result.reason ?? '执行类别未运行', executionMode: result.executionMode };
    if (result.status === 'fail') return { ...item, status: 'fail' as const, reason: result.reason ?? '检查失败', executionMode: result.executionMode };
    const requiredEvidence = new Set(item.evidence);
    const actualEvidence = new Set(result.evidence ?? []);
    const missingEvidence = [...requiredEvidence].filter(category => !actualEvidence.has(category));
    const modeValid = (item.execution === 'offline' && result.executionMode === 'fake') || (item.execution === 'live' && result.executionMode === 'live') || (item.execution === 'manual' && result.executionMode === 'manual' && result.manualStatus === 'confirmed');
    const pending = item.execution === 'manual' && result.manualStatus !== 'confirmed';
    if (missingEvidence.length > 0 || !modeValid || pending) return { ...item, status: 'fail' as const, reason: missingEvidence.length > 0 ? `缺少证据：${missingEvidence.join(',')}` : pending ? '负责人仍为 pending/rejected' : `执行类别不匹配：${result.executionMode}`, executionMode: result.executionMode };
    return { ...item, status: 'pass' as const, executionMode: result.executionMode };
  });
  const requiredChecks = checks.filter(check => check.group !== 'deferred');
  const counts = { pass: requiredChecks.filter(check => check.status === 'pass').length, fail: requiredChecks.filter(check => check.status === 'fail').length, not_run: requiredChecks.filter(check => check.status === 'not_run').length };
  const conclusion = requiredChecks.every(check => check.status === 'pass') ? 'pass' : 'fail';
  return { checks, counts, conclusion };
}
