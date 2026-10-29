/**
 * P06-7 / F-001 P06 阶段验收契约：冻结清单、场景矩阵、证据类别与执行策略
 * （开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口）。
 *
 * 复用 P01～P05 已建立的验收契约机制（scripts/acceptance/p05-config.ts 等），
 * 按 input/p06-acceptance.md §3.2、§3.3、§4 与 execution-contract.md
 * 「测试与验收命令约定」冻结 P06 专属的版本化输入契约：
 *
 * - **清单驱动**：FR-1（存量接入离线闭环演示）与 FR-2（负例与证据）逐项映射
 *   接入/配置/知识/增量/资源隔离/stdio MCP 场景 I01～I08；每项冻结 ID、分组、
 *   验证层次（unit / feature-integration / phase-acceptance）、执行类别
 *   （offline / live / manual / postponed）、前序 Feature、场景、FR、验收引用、
 *   断言与证据类别；未知字段、未知/重复检查、删减断言、改写执行类别一律拒绝；
 * - **默认执行模式**：offline = 无网络、无真实模型调用、脚本化 Runtime；
 *   SQLite/Git/文件/进程使用真实临时资源。stdio MCP 只允许本地无凭据 Fake
 *   server，其他传输明确 unsupported；真实模型调用属 live，必须显式授权；
 * - **严格三态**：pass / fail / not_run；not_run 不计通过，deferred 不计通过，
 *   manual pending/rejected 不能由机器代签；offline 结果不能满足 live 检查，
 *   缺证据类别即 fail，不以日志成功文本或测试数量作为通过依据；
 * - **前置门槛**：前序 P06-1～P06-6 未交付或接口不满足时评估为 blocked，
 *   步骤记 not_run，不得以占位实现或降低门槛放行；
 * - **稳定摘要**：清单内容产生稳定 sha256 摘要（键序无关），报告可追溯清单版本；
 * - **显式全仓**：全仓历史回归默认关闭，只能经 --full-regression 显式开启。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接运行。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const P06_CHECKLIST_VERSION = 1;
export const P06_ACCEPT_CONFIG_VERSION = 1;
export const P06_ENTRY_SCHEMA_VERSION = 1;
export const P06_CHECKLIST_PATH = 'acceptance/p06.checklist.json';
export const P06_ACCEPT_CONFIG_PATH = 'acceptance/p06.config.json';
export const P06_ENTRY_PATH = 'acceptance/p06.entry.json';

export const P06_FEATURES = ['P06-1', 'P06-2', 'P06-3', 'P06-4', 'P06-5', 'P06-6'] as const;
export const P06_LAYERS = ['unit', 'feature-integration', 'phase-acceptance'] as const;
export type P06Layer = (typeof P06_LAYERS)[number];
export const P06_EXECUTION_TYPES = ['offline', 'live', 'manual', 'postponed'] as const;
export type P06ExecutionType = (typeof P06_EXECUTION_TYPES)[number];
export const P06_EVIDENCE_CATEGORIES = [
  'command-exit', 'sqlite', 'git', 'process', 'artifact', 'report', 'manifest',
  'live', 'manual', 'sha', 'usage', 'cleanup',
] as const;
export type P06EvidenceCategory = (typeof P06_EVIDENCE_CATEGORIES)[number];
export const P06_FR_IDS = ['FR-1', 'FR-2'] as const;
export const P06_SCENARIO_IDS = ['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08'] as const;
export const P06_REPORT_STATUSES = ['pass', 'fail', 'not_run'] as const;
export type P06ReportStatus = (typeof P06_REPORT_STATUSES)[number];

export const P06_COUNT_RULE =
  '必需项全部 pass 才算通过；not_run 和人工 pending 不计入通过；deferred 项不参与通过计数；覆盖按必需断言与可观察事实判定，不按日志成功文本或测试数量判断';

export const P06_TOOLCHAIN = {
  packageManager: 'npm@10.9.3', node: '22.19.0', npm: '10.9.3', lockfile: 'package-lock.json',
} as const;
export const P06_FAKE_IDENTITY = {
  provider: 'fake-provider', model: 'fake-model', realModel: false, network: 'denied',
} as const;
export const P06_TEMP_RESOURCES = {
  git: 'temp', sqlite: 'temp', dataRoot: 'temp', home: 'temp', processes: 'owned-only', reusePrevious: false,
} as const;
/** stdio MCP 验收边界：只允许本地无凭据 Fake server，其他传输 unsupported。 */
export const P06_MCP_POLICY = {
  acceptedTransport: 'stdio',
  server: 'local-no-credential-fake',
  realCredentials: false,
  otherTransports: 'unsupported',
} as const;
export const P06_REPORT_SCOPE = {
  statuses: ['pass', 'fail', 'not_run'], includeEvidenceHash: true, includeManualChecklist: true,
  notRunCountsAsPassed: false, deferredCountsAsPassed: false,
} as const;
export const P06_EXECUTION_POLICY = {
  offline: { runtime: 'fake-or-scripted', network: 'denied', llmCalls: false },
  live: { authorizationRequired: true, boundedRequestsRequired: true, credentialsInEvidence: false },
  manual: { ownerConfirmationRequired: true, machineMaySign: false },
  notRun: { countsAsPassed: false },
} as const;
export const P06_ENTRY_STEP_ORDER = ['p06-prerequisites', 'p06-scenario-close-loop', 'p06-trusted-index', 'p06-manual-gate'] as const;
export const P06_ENTRY_MCP = {
  transport: 'stdio',
  server: 'local-no-credential-fake',
  otherTransports: ['http', 'sse'],
  otherTransportsStatus: 'unsupported',
} as const;
export const P06_ENTRY_EVIDENCE_REQUIRED_FIELDS = [
  'scenarioId', 'inputDigest', 'testedCommit', 'command', 'exitCode', 'status', 'evidenceRefs', 'usageSource', 'cleanup',
] as const;

export type P06ItemGroup = 'fr' | 'scenario' | 'live' | 'manual' | 'deferred';
export type P06FrozenItem = {
  readonly id: string;
  readonly group: P06ItemGroup;
  readonly title: string;
  readonly layer: P06Layer;
  readonly execution: P06ExecutionType;
  readonly features: readonly string[];
  readonly scenarioIds: readonly string[];
  readonly fr: readonly string[];
  readonly acceptanceRefs: readonly string[];
  readonly assertions: readonly string[];
  readonly evidence: readonly P06EvidenceCategory[];
  readonly coverage?: 'partial' | null;
  readonly coverageNote?: string | null;
  readonly deferredStatus?: 'not_run' | 'postponed';
};

const FR_ITEMS: readonly P06FrozenItem[] = [
  {
    id: 'P06-FR1-OFFLINE-CLOSURE', group: 'fr', title: 'FR-1 存量接入离线闭环演示', layer: 'phase-acceptance', execution: 'offline',
    features: [...P06_FEATURES], scenarioIds: ['I01', 'I02', 'I03', 'I04', 'I05', 'I06'], fr: ['FR-1'], acceptanceRefs: ['FR-1', 'AC-1', 'AC-3'],
    assertions: [
      '阶段入口使用脚本化 Runtime，不调用真实模型或网络，并逐项绑定场景 ID、输入摘要和受测完整 SHA；SQLite、Git、文件和进程使用真实临时资源',
      '接入带未提交文件和已知失败检查的 Todo 仓库后确认能力/检查、检索项目文档并完成受限增量修改；夹具准备失败或必需检查未运行时明确 not_run 且阶段不通过',
      '重复运行使用独立临时资源，不依赖上一次残留；清理不触及用户仓库',
    ],
    evidence: ['command-exit', 'sqlite', 'git', 'process', 'artifact', 'manifest', 'sha', 'usage', 'cleanup'],
  },
  {
    id: 'P06-FR2-NEGATIVE-EVIDENCE', group: 'fr', title: 'FR-2 负例与证据完整性', layer: 'phase-acceptance', execution: 'offline',
    features: [...P06_FEATURES], scenarioIds: ['I07', 'I08'], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'AC-2', 'AC-4', 'AC-5'],
    assertions: [
      '每项检查绑定场景 ID、输入摘要、受测 commit、实际命令、退出码、状态和证据类别；正常完成文本或测试数量不构成通过依据',
      '每个失败用例核对结果、状态与是否产生意外副作用；不能靠手工改 SQLite、忽略失败或跳过必需检查通过',
      '敏感凭据与开发机绝对路径不进入报告；not_run 与已知缺口如实展示',
    ],
    evidence: ['command-exit', 'artifact', 'report', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const SCENARIO_ITEMS: readonly P06FrozenItem[] = [
  {
    id: 'P06-I01-BROWNFIELD-ONBOARDING', group: 'scenario', title: 'I01 存量 Todo 仓库接入保留脏状态', layer: 'feature-integration', execution: 'offline',
    features: ['P06-5'], scenarioIds: ['I01'], fr: ['FR-1'], acceptanceRefs: ['I01', 'P06-5', 'AC-1'],
    assertions: [
      '带未提交修改、未跟踪文件和已知失败检查的 Todo 存量仓库经显式注册接入，未提交文件保持原样、既有失败不被掩盖',
      '未注册路径、全局目录扫描或目录外知识文件被拒绝并记录原因；登记来源内容变化使旧预览失效',
    ], evidence: ['git', 'sqlite', 'artifact', 'command-exit', 'sha', 'usage', 'cleanup'],
  },
  {
    id: 'P06-I02-PROFILE-CHECK-BASELINE', group: 'scenario', title: 'I02 技术画像与检查基线确认', layer: 'feature-integration', execution: 'offline',
    features: ['P06-1'], scenarioIds: ['I02'], fr: ['FR-1'], acceptanceRefs: ['I02', 'P06-1'],
    assertions: [
      '项目技术画像与检查基线经确认固定，检查命令逐项可执行并绑定真实退出码',
      '画像漂移、检查缺失或未确认基线时失败关闭；不得以占位检查或降低门槛放行',
    ], evidence: ['sqlite', 'artifact', 'command-exit', 'sha', 'usage'],
  },
  {
    id: 'P06-I03-KNOWLEDGE-MANIFEST', group: 'scenario', title: 'I03 项目知识检索与 Manifest 固定', layer: 'feature-integration', execution: 'offline',
    features: ['P06-2'], scenarioIds: ['I03'], fr: ['FR-1'], acceptanceRefs: ['I03', 'P06-2'],
    assertions: [
      'Todo 项目文档按项目范围检索与读取，项目外路径不可见；输入 Manifest 固定后身份与摘要稳定',
      '未固定输入不得进入执行；Manifest 损坏或摘要不匹配时拒绝执行并保留现场',
    ], evidence: ['sqlite', 'artifact', 'sha', 'usage'],
  },
  {
    id: 'P06-I04-RESTRICTED-INCREMENT', group: 'scenario', title: 'I04 受限增量修改与验证', layer: 'feature-integration', execution: 'offline',
    features: ['P06-2', 'P06-6'], scenarioIds: ['I04'], fr: ['FR-1'], acceptanceRefs: ['I04', 'P06-2', 'P06-6'],
    assertions: [
      '脚本化 Runtime 只能修改获准文件，越界写入被拒绝并保留现场；受限增量修改经验证后保留完整输入身份与差异事实',
      '验证失败或修改范围漂移时阻塞，不以模型自报成功替代核对',
    ], evidence: ['git', 'sqlite', 'artifact', 'sha', 'usage'],
  },
  {
    id: 'P06-I05-RESOURCE-ISOLATION', group: 'scenario', title: 'I05 Skills/MCP 资源选择隔离', layer: 'feature-integration', execution: 'offline',
    features: ['P06-3'], scenarioIds: ['I05'], fr: ['FR-1'], acceptanceRefs: ['I05', 'P06-3'],
    assertions: [
      '未选全局 Skills/MCP 资源不加载，首次执行与恢复后均不可用；资源清单按项目隔离',
      '越权资源请求、伪造主体或跨项目访问被拒绝且状态不变，审计记录脱敏',
    ], evidence: ['sqlite', 'process', 'artifact', 'usage', 'cleanup'],
  },
  {
    id: 'P06-I06-STDIO-MCP-FAKE', group: 'scenario', title: 'I06 本地无凭据 stdio MCP Fake server', layer: 'feature-integration', execution: 'offline',
    features: ['P06-4'], scenarioIds: ['I06'], fr: ['FR-1'], acceptanceRefs: ['I06', 'P06-4', 'AC-2'],
    assertions: [
      'stdio MCP 只使用本地无凭据 Fake server 确定性验收：初始化、工具目录、分发、恢复与进程清理全程可观察',
      'http/sse 等其他传输明确记录为 unsupported 或 not_run；真实凭据与外部服务器不进入默认验收',
    ], evidence: ['process', 'sqlite', 'artifact', 'command-exit', 'usage', 'cleanup'],
  },
  {
    id: 'P06-I07-FAIL-CLOSED-NEGATIVES', group: 'scenario', title: 'I07 负例 fail-closed 与副作用核对', layer: 'feature-integration', execution: 'offline',
    features: ['P06-3', 'P06-4', 'P06-5'], scenarioIds: ['I07'], fr: ['FR-2'], acceptanceRefs: ['I07', 'FR-2', 'AC-3'],
    assertions: [
      '无效清单、损坏 Manifest、MCP server 崩溃、越权审批/验收等故障注入核对结果、状态与意外副作用',
      '失败关闭不覆盖既有成功证据、不静默重试放行；恢复操作保留原失败事实',
    ], evidence: ['sqlite', 'process', 'artifact', 'command-exit', 'report', 'cleanup'],
  },
  {
    id: 'P06-I08-RERUN-EVIDENCE-INTEGRITY', group: 'scenario', title: 'I08 重复运行隔离与证据完整性', layer: 'phase-acceptance', execution: 'offline',
    features: [...P06_FEATURES], scenarioIds: ['I08'], fr: ['FR-2'], acceptanceRefs: ['I08', 'AC-4', 'AC-5', 'P06-7'],
    assertions: [
      '重复运行使用独立 run-id 与临时资源，不依赖上一次残留资源；报告绑定 runId、受测 commit 与输入摘要',
      '证据哈希、身份或结构不匹配时 fail-closed；not_run、deferred 与人工 pending 不得折算为通过',
    ], evidence: ['report', 'artifact', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const LIVE_ITEMS: readonly P06FrozenItem[] = [
  {
    id: 'P06-LIVE-REAL-MODEL-AUTH', group: 'live', title: 'P06 live 真实模型调用授权', layer: 'phase-acceptance', execution: 'live',
    features: ['P06-2', 'P06-3', 'P06-5'], scenarioIds: ['I01', 'I04'], fr: ['FR-1'], acceptanceRefs: ['FR-1', 'AC-2', 'P06-7'],
    assertions: [
      '真实模型调用必须由负责人显式授权 provider/model、凭据来源、请求预算与写入范围后才可发起',
      '未授权、无真实证据或预算缺失保持 not_run；离线脚本化 Runtime 与 stdio Fake server 结果不能折算 live 通过',
    ], evidence: ['live', 'command-exit', 'artifact', 'sha', 'usage', 'cleanup'],
  },
];

const MANUAL_ITEMS: readonly P06FrozenItem[] = [
  {
    id: 'P06-MANUAL-OWNER-GATE', group: 'manual', title: 'P06 负责人 macOS 操作与阶段放行', layer: 'phase-acceptance', execution: 'manual',
    features: [...P06_FEATURES], scenarioIds: ['I08'], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'AC-4', 'AC-5'],
    assertions: [
      '负责人按 macOS 清单记录完整 SHA、实际命令、退出码、用量来源、清理事实和未执行项，并明确确认时间与结论',
      'pending/rejected、缺签署、SHA 不匹配或 live not_run 时阶段结论不能通过；机器成功不能代签',
    ], evidence: ['manual', 'report', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const DEFERRED_ITEMS: readonly P06FrozenItem[] = [
  {
    id: 'P06-POST-FULL-HISTORY-REGRESSION', group: 'deferred', title: '后置：全仓历史回归', layer: 'phase-acceptance', execution: 'postponed',
    features: [...P06_FEATURES], scenarioIds: ['I08'], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'FULL-REGRESSION'],
    assertions: [
      '全仓历史回归只能由显式 --full-regression 选项或发布验收发起，不属于默认 P06 阶段门禁',
      '未运行全仓回归报告为 not_run，不计入阶段通过',
    ], evidence: ['command-exit', 'report', 'manifest'],
  },
];

export const P06_FROZEN_ITEMS: readonly P06FrozenItem[] = [
  ...FR_ITEMS, ...SCENARIO_ITEMS, ...LIVE_ITEMS, ...MANUAL_ITEMS, ...DEFERRED_ITEMS,
];
export const P06_REQUIRED_CHECK_IDS = P06_FROZEN_ITEMS.filter(item => item.group !== 'deferred').map(item => item.id);
export const P06_DEFERRED_IDS = P06_FROZEN_ITEMS.filter(item => item.group === 'deferred').map(item => item.id);
const ITEM_BY_ID = new Map(P06_FROZEN_ITEMS.map(item => [item.id, item]));

const CHECKLIST_KEYS = ['checklistVersion', 'phase', 'layers', 'executionTypes', 'evidenceCategories', 'countRule', 'items'] as const;
const ITEM_KEYS = ['id', 'group', 'title', 'layer', 'execution', 'features', 'scenarioIds', 'fr', 'acceptanceRefs', 'assertions', 'evidence'] as const;
const CONFIG_KEYS = ['configVersion', 'checklist', 'reportRoot', 'requiredChecks', 'toolchain', 'timeouts', 'maxCommandOutputBytes', 'fakeIdentity', 'tempResources', 'mcpPolicy', 'executionPolicy', 'reportScope', 'fullRegression', 'usageSources', 'plan'] as const;
const ENTRY_KEYS = ['schemaVersion', 'phase', 'stepOrder', 'trustedIndexRoot', 'requiredFeatures', 'prerequisites', 'defaultExecution', 'mcp', 'explicitOptions', 'evidence'] as const;
const CREDENTIAL_KEY = /(?:authorization|auth|token|password|passwd|secret|credential|cookie|api[_-]?key)/i;
const BUSINESS_KEY = /^(?:schemaVersions|migrations?|settings|database|productConfig|businessConfig)$/i;
const ID_PATTERN = /^P06-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const REF_PATTERN = /^(?:FR-[1-2]|I0[1-8]|P06-[1-7]|AC-[1-5]|FULL-REGRESSION)$/;

export type P06AcceptErrorKind = 'invalid_config';
export class P06AcceptError extends Error {
  readonly kind: P06AcceptErrorKind;
  readonly detail?: string;
  constructor(kind: P06AcceptErrorKind, message: string, detail?: string) { super(message); this.name = 'P06AcceptError'; this.kind = kind; this.detail = detail; }
}
function fail(message: string, detail?: string): never { throw new P06AcceptError('invalid_config', message, detail); }
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
  exactStrings(raw.scenarioIds, expected.scenarioIds, `${raw.id}.scenarioIds`);
  const fr = exactStrings(raw.fr, expected.fr, `${raw.id}.fr`);
  if (fr.some(value => !P06_FR_IDS.includes(value as (typeof P06_FR_IDS)[number]))) fail(`${raw.id}.fr 含未知 FR`);
  const scenarioIds = exactStrings(raw.scenarioIds, expected.scenarioIds, `${raw.id}.scenarioIds`);
  if (scenarioIds.some(value => !P06_SCENARIO_IDS.includes(value as (typeof P06_SCENARIO_IDS)[number]))) fail(`${raw.id}.scenarioIds 含未知场景`);
  const refs = exactStrings(raw.acceptanceRefs, expected.acceptanceRefs, `${raw.id}.acceptanceRefs`);
  if (refs.some(value => !REF_PATTERN.test(value))) fail(`${raw.id}.acceptanceRefs 含未知引用`);
  exactStrings(raw.assertions, expected.assertions, `${raw.id}.assertions`);
  const evidence = exactStrings(raw.evidence, expected.evidence, `${raw.id}.evidence`);
  if (evidence.some(value => !P06_EVIDENCE_CATEGORIES.includes(value as P06EvidenceCategory))) fail(`${raw.id}.evidence 含未知类别`);
}

export function validateP06Checklist(value: unknown): P06Checklist {
  const raw = object(value, 'checklist');
  keys(raw, CHECKLIST_KEYS, 'checklist');
  if (raw.checklistVersion !== P06_CHECKLIST_VERSION || raw.phase !== 'P06') fail('清单版本或阶段不匹配');
  exactStrings(raw.layers, P06_LAYERS, 'layers');
  exactStrings(raw.executionTypes, P06_EXECUTION_TYPES, 'executionTypes');
  exactStrings(raw.evidenceCategories, P06_EVIDENCE_CATEGORIES, 'evidenceCategories');
  if (raw.countRule !== P06_COUNT_RULE) fail('countRule 被改写');
  if (!Array.isArray(raw.items) || raw.items.length !== P06_FROZEN_ITEMS.length) fail('items 数量与冻结清单不一致');
  const seen = new Set<string>();
  (raw.items as unknown[]).forEach((item, index) => {
    validateItem(item, index);
    const id = (item as { id: string }).id;
    if (seen.has(id)) fail(`检查 ID 重复：${id}`);
    seen.add(id);
    if (id !== P06_FROZEN_ITEMS[index].id) fail(`检查顺序被改写：${id}`);
  });
  return { checklistVersion: P06_CHECKLIST_VERSION, phase: 'P06', layers: [...P06_LAYERS], executionTypes: [...P06_EXECUTION_TYPES], evidenceCategories: [...P06_EVIDENCE_CATEGORIES], countRule: P06_COUNT_RULE, items: P06_FROZEN_ITEMS };
}

export type P06FullRegression = { readonly defaultEnabled: false; readonly optInFlag: '--full-regression'; readonly command: readonly string[]; readonly reason: string };
export type P06AcceptanceConfig = {
  readonly configVersion: 1; readonly checklist: string; readonly reportRoot: string; readonly requiredChecks: readonly string[];
  readonly toolchain: typeof P06_TOOLCHAIN; readonly timeouts: { readonly stepMs: number; readonly overallMs: number };
  readonly maxCommandOutputBytes: number; readonly fakeIdentity: typeof P06_FAKE_IDENTITY; readonly tempResources: typeof P06_TEMP_RESOURCES;
  readonly mcpPolicy: typeof P06_MCP_POLICY; readonly executionPolicy: typeof P06_EXECUTION_POLICY; readonly reportScope: typeof P06_REPORT_SCOPE;
  readonly fullRegression: P06FullRegression;
  readonly usageSources: readonly string[]; readonly plan: { readonly phaseId: string; readonly stepId: string; readonly title: string; readonly scope: string; readonly version: string; readonly contractDoc: string };
};

export function validateP06AcceptanceConfig(value: unknown): P06AcceptanceConfig {
  const raw = object(value, 'config'); keys(raw, CONFIG_KEYS, 'config');
  if (raw.configVersion !== 1) fail('configVersion 不匹配');
  const checklist = relativePath(raw.checklist, 'checklist');
  const reportRoot = relativePath(raw.reportRoot, 'reportRoot');
  exactStrings(raw.requiredChecks, P06_REQUIRED_CHECK_IDS, 'requiredChecks');
  same(raw.toolchain, P06_TOOLCHAIN, 'toolchain'); same(raw.fakeIdentity, P06_FAKE_IDENTITY, 'fakeIdentity'); same(raw.tempResources, P06_TEMP_RESOURCES, 'tempResources');
  same(raw.mcpPolicy, P06_MCP_POLICY, 'mcpPolicy');
  const timeouts = object(raw.timeouts, 'timeouts'); keys(timeouts, ['stepMs', 'overallMs'], 'timeouts');
  const stepMs = bounded(timeouts.stepMs, 1_000, 7_200_000, 'timeouts.stepMs');
  const overallMs = bounded(timeouts.overallMs, 1_000, 14_400_000, 'timeouts.overallMs');
  if (overallMs < stepMs) fail('overallMs 不能小于 stepMs');
  bounded(raw.maxCommandOutputBytes, 1_024, 16 * 1024 * 1024, 'maxCommandOutputBytes');
  same(raw.executionPolicy, P06_EXECUTION_POLICY, 'executionPolicy'); same(raw.reportScope, P06_REPORT_SCOPE, 'reportScope');
  const fullRegression = object(raw.fullRegression, 'fullRegression'); keys(fullRegression, ['defaultEnabled', 'optInFlag', 'command', 'reason'], 'fullRegression');
  if (fullRegression.defaultEnabled !== false || fullRegression.optInFlag !== '--full-regression') fail('全仓历史回归必须关闭默认开关并使用显式 --full-regression');
  exactStrings(fullRegression.command, ['npm', 'test'], 'fullRegression.command');
  if (typeof fullRegression.reason !== 'string' || fullRegression.reason.length === 0) fail('fullRegression.reason 必须说明显式开关原因');
  const usageSources = strings(raw.usageSources, 'usageSources');
  if (new Set(usageSources).size !== usageSources.length || !usageSources.includes('runtime-usage') || !usageSources.includes('command-output') || !usageSources.includes('manual-record') || !usageSources.includes('not_run')) fail('usageSources 必须包含稳定的用量来源分类');
  const plan = object(raw.plan, 'plan'); keys(plan, ['phaseId', 'stepId', 'title', 'scope', 'version', 'contractDoc'], 'plan');
  for (const key of ['phaseId', 'stepId', 'title', 'scope', 'version'] as const) if (typeof plan[key] !== 'string' || plan[key].length === 0) fail(`plan.${key} 必须是非空字符串`);
  const contractDoc = relativePath(plan.contractDoc, 'plan.contractDoc');
  return { configVersion: 1, checklist, reportRoot, requiredChecks: [...P06_REQUIRED_CHECK_IDS], toolchain: P06_TOOLCHAIN, timeouts: { stepMs, overallMs }, maxCommandOutputBytes: raw.maxCommandOutputBytes as number, fakeIdentity: P06_FAKE_IDENTITY, tempResources: P06_TEMP_RESOURCES, mcpPolicy: P06_MCP_POLICY, executionPolicy: P06_EXECUTION_POLICY, reportScope: P06_REPORT_SCOPE, fullRegression: { defaultEnabled: false, optInFlag: '--full-regression', command: ['npm', 'test'], reason: fullRegression.reason as string }, usageSources, plan: { phaseId: plan.phaseId as string, stepId: plan.stepId as string, title: plan.title as string, scope: plan.scope as string, version: plan.version as string, contractDoc } };
}

export type P06EntryContract = {
  readonly schemaVersion: 1;
  readonly phase: 'P06';
  readonly stepOrder: readonly string[];
  readonly trustedIndexRoot: string;
  readonly requiredFeatures: readonly string[];
  readonly prerequisites: { readonly missingBehavior: 'blocked-not-run'; readonly placeholderAllowed: false };
  readonly defaultExecution: { readonly mode: 'offline'; readonly network: 'denied'; readonly llmCalls: false; readonly fullRegression: false };
  readonly mcp: typeof P06_ENTRY_MCP;
  readonly explicitOptions: { readonly fullRegression: '--full-regression'; readonly live: '--live-authorized'; readonly manual: '--manual-record' };
  readonly evidence: { readonly requiredFields: readonly string[]; readonly statuses: readonly string[]; readonly notRunCountsAsPassed: false };
};

export function validateP06EntryContract(value: unknown): P06EntryContract {
  const raw = object(value, 'entry'); keys(raw, ENTRY_KEYS, 'entry');
  if (raw.schemaVersion !== P06_ENTRY_SCHEMA_VERSION || raw.phase !== 'P06') fail('入口契约版本或阶段不匹配');
  exactStrings(raw.stepOrder, P06_ENTRY_STEP_ORDER, 'stepOrder');
  const trustedIndexRoot = relativePath(raw.trustedIndexRoot, 'trustedIndexRoot');
  exactStrings(raw.requiredFeatures, P06_FEATURES, 'requiredFeatures');
  const prerequisites = object(raw.prerequisites, 'prerequisites'); keys(prerequisites, ['missingBehavior', 'placeholderAllowed'], 'prerequisites');
  if (prerequisites.missingBehavior !== 'blocked-not-run') fail('前序 Feature 缺失必须记为阻塞/not_run');
  if (prerequisites.placeholderAllowed !== false) fail('不得允许占位实现满足前置门槛');
  const defaultExecution = object(raw.defaultExecution, 'defaultExecution'); keys(defaultExecution, ['mode', 'network', 'llmCalls', 'fullRegression'], 'defaultExecution');
  same(defaultExecution, { mode: 'offline', network: 'denied', llmCalls: false, fullRegression: false }, 'defaultExecution');
  const mcp = object(raw.mcp, 'mcp'); keys(mcp, ['transport', 'server', 'otherTransports', 'otherTransportsStatus'], 'mcp');
  same(mcp, P06_ENTRY_MCP, 'mcp');
  const explicitOptions = object(raw.explicitOptions, 'explicitOptions'); keys(explicitOptions, ['fullRegression', 'live', 'manual'], 'explicitOptions');
  same(explicitOptions, { fullRegression: '--full-regression', live: '--live-authorized', manual: '--manual-record' }, 'explicitOptions');
  const evidence = object(raw.evidence, 'evidence'); keys(evidence, ['requiredFields', 'statuses', 'notRunCountsAsPassed'], 'evidence');
  exactStrings(evidence.requiredFields, P06_ENTRY_EVIDENCE_REQUIRED_FIELDS, 'evidence.requiredFields');
  exactStrings(evidence.statuses, P06_REPORT_STATUSES, 'evidence.statuses');
  if (evidence.notRunCountsAsPassed !== false) fail('not_run 不得计为通过');
  return {
    schemaVersion: P06_ENTRY_SCHEMA_VERSION, phase: 'P06', stepOrder: [...P06_ENTRY_STEP_ORDER], trustedIndexRoot,
    requiredFeatures: [...P06_FEATURES], prerequisites: { missingBehavior: 'blocked-not-run', placeholderAllowed: false },
    defaultExecution: { mode: 'offline', network: 'denied', llmCalls: false, fullRegression: false },
    mcp: P06_ENTRY_MCP, explicitOptions: { fullRegression: '--full-regression', live: '--live-authorized', manual: '--manual-record' },
    evidence: { requiredFields: [...P06_ENTRY_EVIDENCE_REQUIRED_FIELDS], statuses: [...P06_REPORT_STATUSES], notRunCountsAsPassed: false },
  };
}

export type P06Checklist = { readonly checklistVersion: 1; readonly phase: 'P06'; readonly layers: readonly P06Layer[]; readonly executionTypes: readonly P06ExecutionType[]; readonly evidenceCategories: readonly P06EvidenceCategory[]; readonly countRule: string; readonly items: readonly P06FrozenItem[] };
function parseJsonFile(path: string, label: string): unknown {
  if (!existsSync(path)) fail(`${label}不存在：${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { fail(`${label}不是有效 JSON：${String(error)}`); }
}
export function loadP06Checklist(path = P06_CHECKLIST_PATH): P06Checklist { return validateP06Checklist(parseJsonFile(path, '清单')); }
export function loadP06AcceptanceConfig(path: string): P06AcceptanceConfig { return validateP06AcceptanceConfig(parseJsonFile(path, '配置')); }
export function loadP06EntryContract(path = P06_ENTRY_PATH): P06EntryContract { return validateP06EntryContract(parseJsonFile(path, '入口契约')); }

export function summarizeP06Checklist(checklist: P06Checklist): { required: number; deferred: number; byExecution: Record<P06ExecutionType, number>; byFeature: Record<string, number> } {
  const byExecution = Object.fromEntries(P06_EXECUTION_TYPES.map(type => [type, checklist.items.filter(item => item.execution === type).length])) as Record<P06ExecutionType, number>;
  const byFeature = Object.fromEntries(P06_FEATURES.map(feature => [feature, checklist.items.filter(item => item.features.includes(feature)).length]));
  return { required: checklist.items.filter(item => item.group !== 'deferred').length, deferred: checklist.items.filter(item => item.group === 'deferred').length, byExecution, byFeature };
}

/** 键序无关的稳定序列化，用于清单摘要。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 清单内容摘要：内容或结构变化即变化，报告以此追溯清单版本。 */
export function digestP06Checklist(checklist: P06Checklist): string {
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

/* ------------------------------------------------------------------ *
 * 前置门槛：前序 P06 Feature 未交付或接口不满足时阻塞 / not_run
 * ------------------------------------------------------------------ */

export type P06PrerequisiteInput = {
  readonly feature: string;
  readonly delivered: boolean;
  readonly interfacesSatisfied?: boolean;
  readonly note?: string;
};
export type P06PrerequisiteEvaluation = {
  readonly status: 'satisfied' | 'blocked';
  readonly resultStatus: 'pass' | 'not_run';
  readonly blockedFeatures: readonly string[];
  readonly reason: string;
};

export function evaluateP06Prerequisites(inputs: readonly P06PrerequisiteInput[]): P06PrerequisiteEvaluation {
  const byFeature = new Map<string, P06PrerequisiteInput>();
  for (const input of inputs) {
    if (typeof input.feature !== 'string' || !P06_FEATURES.includes(input.feature as (typeof P06_FEATURES)[number])) fail(`前置输入含未知 Feature：${String(input.feature)}`);
    if (byFeature.has(input.feature)) fail(`前置输入含重复 Feature：${input.feature}`);
    if (typeof input.delivered !== 'boolean') fail(`前置输入 ${input.feature}.delivered 必须是布尔值`);
    byFeature.set(input.feature, input);
  }
  const blockedFeatures = P06_FEATURES.filter(feature => {
    const input = byFeature.get(feature);
    if (!input || !input.delivered) return true;
    return input.interfacesSatisfied === false;
  });
  if (blockedFeatures.length === 0) {
    return { status: 'satisfied', resultStatus: 'pass', blockedFeatures: [], reason: '前序 P06-1～P06-6 均已交付且接口满足' };
  }
  return {
    status: 'blocked',
    resultStatus: 'not_run',
    blockedFeatures,
    reason: `前序 Feature 未交付或接口不满足：${blockedFeatures.join(',')}；相关步骤记 not_run，不得以占位实现或降低门槛放行`,
  };
}

/* ------------------------------------------------------------------ *
 * 严格三态聚合
 * ------------------------------------------------------------------ */

export type P06CheckResult = { readonly checkId: string; readonly status: P06ReportStatus; readonly executionMode: 'fake' | 'live' | 'manual'; readonly evidence?: readonly string[]; readonly manualStatus?: 'pending' | 'confirmed' | 'rejected'; readonly reason?: string };
export type P06AggregatedCheck = P06FrozenItem & { readonly status: P06ReportStatus; readonly reason?: string; readonly executionMode?: string };
export type P06Aggregate = { readonly checks: readonly P06AggregatedCheck[]; readonly counts: { readonly pass: number; readonly fail: number; readonly not_run: number }; readonly conclusion: 'pass' | 'fail' };
export function aggregateP06CheckResults(checklist: P06Checklist, results: readonly P06CheckResult[]): P06Aggregate {
  const byId = new Map<string, P06CheckResult>();
  for (const result of results) { if (!ITEM_BY_ID.has(result.checkId)) throw new P06AcceptError('invalid_config', `结果含未知检查：${result.checkId}`); if (byId.has(result.checkId)) throw new P06AcceptError('invalid_config', `结果含重复检查：${result.checkId}`); byId.set(result.checkId, result); }
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

// Compatibility surface for the shared acceptance engine.
export type P06ChecklistItem = P06FrozenItem;
export type P06DeferredStatus = 'not_run' | 'postponed';
export type P06Coverage = 'partial';
export const P06_ACCEPT_MIN_TIMEOUT_MS = 1_000;
export const P06_ACCEPT_MAX_TIMEOUT_MS = 7_200_000;
export const P06_ACCEPT_MIN_OUTPUT_BYTES = 1_024;
export const P06_ACCEPT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
