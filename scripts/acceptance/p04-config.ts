/**
 * P04-10 / F-002 P04 阶段验收机器可读检查清单与受校验配置
 * （开发验收工具输入，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口）。
 *
 * 交付面（固定 FR、验收编号与证据要求的映射）：
 * - `acceptance/p04.checklist.json`：机器可读检查清单。每项有稳定 ID、FR 映射、
 *   验收编号（T 编号）映射、必需断言、证据类别与验证层次（unit / feature-integration /
 *   phase-acceptance）；完成、预算耗尽、人工阻塞、最终检查失败、仅收尾重试五个
 *   纵向演示单独成项；
 * - `acceptance/p04.config.json`：阶段验收配置（configVersion=1），包含 npm 与
 *   P01/P02 版本约束（Node/npm 精确版本、npm@10.9.3、package-lock.json）、有限
 *   步骤/总时间预算、命令输出上限、显式 Fake 身份、临时资源与报告范围；
 * - 本文件的冻结基线与 fail-closed 校验：无效配置、重复/未知检查 ID、试图减少
 *   或改写必需项（含删减断言、改写 T/FR 映射、降级层次、把 deferred 计入通过）
 *   一律拒绝（invalid_config）。
 *
 * 边界（PRD FR-3/约束）：
 * - 本配置是**验收工具输入**：不新增业务版本表，不构成第二套产品配置体系
 *   （schemaVersions/migrations/settings/database/credentials 等键一律拒绝）；
 * - 确定性离线、获准 Pi live、人工确认和后置能力分别标注执行类别；后置能力明确为
 *   postponed，不参与 P04 已通过计数；live 缺授权时准确保留 pending/not_run；
 * - T43/T44 分离标准 SDK 恢复能力与 checkpoint/Durable 独有能力，不以 conversation resume
 *   或 mock 结果冒充 execution recovery；
 * - 单元测试、Feature 集成与阶段验收分层标注；覆盖由必需断言判定，不按测试数量判断。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接运行；
 * 不调用模型，不联网，不读取用户认证/凭据，不修改任何文件。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/* ------------------------------------------------------------------ *
 * 常量、词汇表与错误
 * ------------------------------------------------------------------ */

export const P04_CHECKLIST_VERSION = 1;
export const P04_ACCEPT_CONFIG_VERSION = 1;
export const P04_CHECKLIST_PATH = 'acceptance/p04.checklist.json';
export const P04_ACCEPT_CONFIG_PATH = 'acceptance/p04.config.json';

/** 验证层次词汇表：区分单元测试、Feature 集成与阶段验收。 */
export const P04_LAYERS = ['unit', 'feature-integration', 'phase-acceptance'] as const;
export type P04Layer = (typeof P04_LAYERS)[number];

/** 执行类别词汇表：清单必须区分离线、live、人工确认和后置能力。 */
export const P04_EXECUTION_TYPES = ['offline', 'live', 'manual', 'postponed'] as const;
export type P04ExecutionType = (typeof P04_EXECUTION_TYPES)[number];

/** 证据类别词汇表：每项必需断言对应的证据形态。 */
export const P04_EVIDENCE_CATEGORIES = [
  'command-exit',
  'sqlite',
  'git',
  'process',
  'artifact',
  'report',
  'manifest',
  'live',
  'manual',
] as const;
export type P04EvidenceCategory = (typeof P04_EVIDENCE_CATEGORIES)[number];

export const P04_FR_IDS = ['FR-1', 'FR-2', 'FR-3', 'FR-4'] as const;

export type P04ItemGroup = 'fr' | 'acceptance' | 'vertical' | 'deferred';
export type P04DeferredStatus = 'not_run' | 'postponed';
export type P04Coverage = 'partial';

/** 覆盖判定规则（冻结文案）：不按测试数量判断覆盖。 */
export const P04_COUNT_RULE =
  '必需项全部 pass 才算通过；deferred 项显示 not_run 或 postponed，不参与 P04 已通过计数；覆盖按必需断言判定，不按测试数量判断';

/**
 * 沿用 npm 与 P01/P02 冻结的版本约束（root package.json engines/packageManager、
 * package-lock.json）；P04 不另立包管理器或工具版本。
 */
export const P04_TOOLCHAIN = {
  packageManager: 'npm@10.9.3',
  node: '22.19.0',
  npm: '10.9.3',
  lockfile: 'package-lock.json',
} as const;

/** 有限步骤/总时间预算的合法范围（有限正毫秒）。 */
export const P04_ACCEPT_MIN_TIMEOUT_MS = 1_000;
export const P04_ACCEPT_MAX_TIMEOUT_MS = 7_200_000;
/** 命令输出上限的合法范围（字节）。 */
export const P04_ACCEPT_MIN_OUTPUT_BYTES = 1_024;
export const P04_ACCEPT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** 显式 Fake 身份（冻结）：P04 确定性验收不调用真实模型/live。 */
export const P04_FAKE_IDENTITY = {
  provider: 'fake-provider',
  model: 'fake-model',
  realModel: false,
  network: 'denied',
} as const;

/** 临时资源声明（冻结）：全部为隔离临时资源，不复用上一次资源。 */
export const P04_TEMP_RESOURCES = {
  git: 'temp',
  sqlite: 'temp',
  dataRoot: 'temp',
  home: 'temp',
  reusePrevious: false,
} as const;

/** 报告范围（冻结）：not_run/deferred 可见且不计入已通过数。 */
export const P04_REPORT_SCOPE = {
  statuses: ['pass', 'fail', 'not_run'],
  includeEvidenceHash: true,
  includeManualChecklist: true,
  deferredCountsAsPassed: false,
} as const;

const CHECKLIST_ALLOWED_KEYS = [
  'checklistVersion',
  'phase',
  'layers',
  'evidenceCategories',
  'countRule',
  'items',
] as const;
const ITEM_ALLOWED_KEYS = [
  'id',
  'group',
  'title',
  'layer',
  'execution',
  'fr',
  'acceptanceRefs',
  'assertions',
  'evidence',
  'coverage',
  'coverageNote',
  'deferredStatus',
] as const;
const CONFIG_ALLOWED_KEYS = [
  'configVersion',
  'checklist',
  'reportRoot',
  'requiredChecks',
  'toolchain',
  'timeouts',
  'maxCommandOutputBytes',
  'fakeIdentity',
  'tempResources',
  'reportScope',
  'plan',
] as const;

/**
 * 业务配置体系禁用键：本配置是验收工具输入，不得出现业务版本表/产品配置/凭据语义
 * （PRD 约束：不新增业务版本表或第二套产品配置体系）。
 */
const BUSINESS_CONFIG_KEY_PATTERN =
  /^(?:schemaVersions|migrations?|settings|database|productConfig|businessConfig|credentials?|token|password|secret|api[_-]?key)$/i;
const CREDENTIAL_KEY_PATTERN =
  /(?:authorization|auth|token|password|passwd|secret|credential|cookie|api[_-]?key)/i;
const CHECK_ID_PATTERN = /^P04-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const T_REF_PATTERN = /^[A-Z]\d{2}$/;
const FR_REF_PATTERN = /^FR-[1-4]$/;

export type P04AcceptErrorKind = 'invalid_config';

export class P04AcceptError extends Error {
  readonly kind: P04AcceptErrorKind;
  readonly detail?: string;

  constructor(kind: P04AcceptErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'P04AcceptError';
    this.kind = kind;
    this.detail = detail;
  }
}

function fail(kind: P04AcceptErrorKind, message: string, detail?: string): never {
  throw new P04AcceptError(kind, message, detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(raw)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      fail('invalid_config', `${label} 含认证/凭据字段 ${key}：验收配置不解析用户认证`);
    }
    if (BUSINESS_CONFIG_KEY_PATTERN.test(key)) {
      fail(
        'invalid_config',
        `${label} 含业务配置字段 ${key}：本配置是验收工具输入，不新增业务版本表或第二套产品配置体系`,
      );
    }
    if (!allowed.includes(key)) {
      fail('invalid_config', `${label} 含未知字段：${key}`);
    }
  }
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    fail('invalid_config', `${label} 必须是数组`);
  }
  return (value as unknown[]).map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      fail('invalid_config', `${label}[${index}] 必须是非空字符串`);
    }
    return entry as string;
  });
}

function assertSameStringArray(
  value: unknown,
  expected: readonly string[],
  label: string,
  reason: string,
): string[] {
  const actual = assertStringArray(value, label);
  if (actual.length !== expected.length) {
    fail(
      'invalid_config',
      `${label} 与冻结基线不一致（${reason}）：期望 ${expected.length} 项 ${JSON.stringify(expected)}，收到 ${JSON.stringify(actual)}`,
    );
  }
  actual.forEach((entry, index) => {
    if (entry !== expected[index]) {
      fail(
        'invalid_config',
        `${label}[${index}] 与冻结基线不一致（${reason}）：期望 ${String(expected[index])}，收到 ${entry}`,
      );
    }
  });
  return actual;
}

function assertConfigRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_config', `${label} 必须是非空字符串`);
  }
  const path = value as string;
  if (path.includes('\0') || path.startsWith('/') || path.includes('\\') || isAbsolute(path)) {
    fail('invalid_config', `${label} 必须是仓库内 POSIX 相对路径（禁止绝对路径/路径逃逸）：${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid_config', `${label} 不允许空段/./..（禁止路径逃逸）：${path}`);
  }
  return segments.join('/');
}

function assertBoundedInt(value: unknown, min: number, max: number, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    fail('invalid_config', `${label} 必须是 ${min}~${max} 的有限整数（不得为 0/Infinity/NaN/非数字）`);
  }
  return value as number;
}

/* ------------------------------------------------------------------ *
 * 冻结检查清单（固定 FR、验收编号与证据要求的映射）
 * ------------------------------------------------------------------ */

export type P04FrozenItem = {
  readonly id: string;
  readonly group: P04ItemGroup;
  readonly title: string;
  readonly layer: P04Layer;
  readonly execution: P04ExecutionType;
  readonly fr: readonly string[];
  readonly acceptanceRefs: readonly string[];
  readonly assertions: readonly string[];
  readonly evidence: readonly P04EvidenceCategory[];
  readonly coverage?: P04Coverage;
  readonly coverageNote?: string;
  readonly deferredStatus?: P04DeferredStatus;
};

const FR_ITEMS: readonly P04FrozenItem[] = [
  {
    id: 'P04-FR1-FAILURE-MATRIX', group: 'fr',
    title: 'FR-1 确定性集成与故障矩阵', layer: 'phase-acceptance', execution: 'offline',
    fr: ['FR-1'], acceptanceRefs: ['T35', 'T36', 'T41', 'T42'],
    assertions: [
      'SDK、认证、资源授权、工具越权、限流/连接/服务端错误、重试与备用均有可重放的业务状态和副作用断言',
      '取消、超时、强杀、迟到结果、存储故障与清理事实分别记录，失败或未运行不冒充通过',
    ],
    evidence: ['command-exit', 'sqlite', 'process', 'manifest'],
  },
  {
    id: 'P04-FR2-BOUNDED-ENTRY', group: 'fr',
    title: 'FR-2 独立阶段入口与有界执行', layer: 'phase-acceptance', execution: 'offline',
    fr: ['FR-2'], acceptanceRefs: ['T35', 'T37'],
    assertions: [
      '步骤按固定 argv/cwd 和有限单步/总预算顺序执行，每步开始即保存运行身份、日志位置、状态、退出码和耗时',
      '缺入口、超时、未知退出码、证据写入失败、非空目录或输入不匹配均 fail-closed，前序证据保留',
    ],
    evidence: ['command-exit', 'artifact', 'manifest'],
  },
  {
    id: 'P04-FR3-LIVE-GUARD', group: 'fr',
    title: 'FR-3 真实 Pi live 授权边界', layer: 'phase-acceptance', execution: 'live',
    fr: ['FR-3'], acceptanceRefs: ['T40', 'T41', 'T43', 'T44'],
    assertions: [
      'live 输入明确 provider/model、获准认证来源、临时 Git、资源与预算；缺授权或认证时 zero-call 并保持 not_run',
      '已授权调用记录真实模型、工具过程、usage、取消/停止和恢复结果；未知能力和缺失字段准确标记 unknown/partial',
    ],
    evidence: ['command-exit', 'git', 'process', 'live'],
  },
  {
    id: 'P04-FR4-MANUAL-GATE', group: 'fr',
    title: 'FR-4 报告与人工阶段放行门槛', layer: 'phase-acceptance', execution: 'manual',
    fr: ['FR-4'], acceptanceRefs: ['T39'],
    assertions: [
      '报告保存受测 commit、工具版本、命令身份、运行状态、耗时、退出码、证据引用、覆盖度、清理事实和已知缺口',
      '完整工程/集成、获准 live 和负责人确认三者缺一不可；工具交付通过不能替代阶段验收通过',
    ],
    evidence: ['report', 'manual', 'manifest'],
  },
];

const ACCEPTANCE_ITEMS: readonly P04FrozenItem[] = [
  {
    id: 'P04-T35', group: 'acceptance', title: 'T35 局部测试选择与安全回退',
    layer: 'feature-integration', execution: 'offline', fr: ['FR-1', 'FR-2'], acceptanceRefs: ['T35'],
    assertions: ['选择使用已登记的测试文件和稳定 case，记录 argv/cwd/timeout/退出码；候选缺失、越界或零测试按策略拒绝或回退', '不递归启动全仓或阶段入口，选择范围和缺口可追溯'],
    evidence: ['artifact', 'command-exit'],
  },
  {
    id: 'P04-T36', group: 'acceptance', title: 'T36 失败、超时和未知停止状态',
    layer: 'feature-integration', execution: 'offline', fr: ['FR-1', 'FR-2'], acceptanceRefs: ['T36'],
    assertions: ['步骤失败、超时、缺入口、证据损坏和停止不确定均返回非零并保留现场', '未确认停止不得释放资源、重跑或写入 processesGone=true'],
    evidence: ['command-exit', 'process', 'manifest'],
  },
  {
    id: 'P04-T37', group: 'acceptance', title: 'T37 证据目录隔离与运行身份',
    layer: 'feature-integration', execution: 'offline', fr: ['FR-2', 'FR-4'], acceptanceRefs: ['T37'],
    assertions: ['非空证据目录、受测 commit 不匹配或资源输入不匹配时拒绝覆盖和复用旧成功', '每步保存稳定运行身份、命令、日志位置、退出码和耗时'],
    evidence: ['artifact', 'manifest'],
  },
  {
    id: 'P04-T39', group: 'acceptance', title: 'T39 人工确认优先于机器成功',
    layer: 'feature-integration', execution: 'manual', fr: ['FR-4'], acceptanceRefs: ['T39'],
    assertions: ['负责人未确认、明确阻塞或代码摘要不匹配时，机器全绿不能放行 P05', '确认记录包含负责人身份、时间、结论并绑定受测 commit；模型不能自行签字'],
    evidence: ['report', 'manual'],
  },
  {
    id: 'P04-T40', group: 'acceptance', title: 'T40 同 Task 续接与增量审计',
    layer: 'feature-integration', execution: 'offline', fr: ['FR-1', 'FR-3'], acceptanceRefs: ['T40'],
    assertions: ['续接前核验旧执行停止、身份和输入兼容；auto/new/required 决策及不支持原因可追溯', '旧档案不变，历史事件、usage 和新回复不重复计量，预算不因新 Attempt 清零'],
    evidence: ['sqlite', 'process', 'artifact'],
  },
  {
    id: 'P04-T41', group: 'acceptance', title: 'T41 认证、预检、重试与备用边界',
    layer: 'feature-integration', execution: 'offline', fr: ['FR-1', 'FR-3'], acceptanceRefs: ['T41'],
    assertions: ['认证失败、推理失败、限流、连接、服务端和协议错误分类清晰，重试受统一预算约束', '未经批准不切换 provider/model；未授权场景真实请求数为零'],
    evidence: ['command-exit', 'artifact', 'live'],
  },
  {
    id: 'P04-T42', group: 'acceptance', title: 'T42 长轮次与工具过程诊断',
    layer: 'feature-integration', execution: 'offline', fr: ['FR-1', 'FR-4'], acceptanceRefs: ['T42'],
    assertions: ['工具调用、重读、错误、大输出、上下文和检查耗时分别记录，缺字段保持 unknown', '诊断告警不改业务状态，不以不同 Task 或 Fake 结果宣称真实节省'],
    evidence: ['artifact', 'report'],
  },
  {
    id: 'P04-T43', group: 'acceptance', title: 'T43 恢复能力分离与未知能力拒绝',
    layer: 'feature-integration', execution: 'live', fr: ['FR-3'], acceptanceRefs: ['T43'],
    assertions: ['conversation resume、execution recovery 和 checkpoint 能力分开记录；required 不支持时明确拒绝', '跨项目/用途、活跃旧执行和未知能力按 fail-closed 处理，不加载未授权原生存储'],
    evidence: ['live', 'process', 'report'],
  },
  {
    id: 'P04-T44', group: 'acceptance', title: 'T44 live 稳定身份、停止与增量用量',
    layer: 'feature-integration', execution: 'live', fr: ['FR-3'], acceptanceRefs: ['T44'],
    assertions: ['重复请求、工具前后崩溃、停止不确定、重复事件/usage 和两个写入者均保留可追踪证据', 'live 事实按当前调用增量记录，已通过 Task 和历史登录日志不能替代实际运行'],
    evidence: ['live', 'process', 'manifest'],
  },
];

const VERTICAL_ITEMS: readonly P04FrozenItem[] = [
  {
    id: 'P04-VERT-OFFLINE-FAIL-CLOSED', group: 'vertical', title: '纵向演示：离线集成与失败关闭',
    layer: 'phase-acceptance', execution: 'offline', fr: ['FR-1', 'FR-2'], acceptanceRefs: ['T35', 'T36', 'T37'],
    assertions: ['确定性集成场景独立执行且不调用模型/网络，步骤故障、证据损坏和清理失败均形成非零报告', '失败保留已完成步骤证据、现场和已知缺口'],
    evidence: ['command-exit', 'artifact', 'manifest'],
  },
  {
    id: 'P04-VERT-LIVE-ZERO-CALL', group: 'vertical', title: '纵向演示：live 无授权零调用',
    layer: 'phase-acceptance', execution: 'live', fr: ['FR-3'], acceptanceRefs: ['T41'],
    assertions: ['缺认证或未获批准时不发真实 Pi 请求，报告记录 zero-call 和 not_run/pending', '不以 Fake、mock 或已完成 Task 替代 live 证据'],
    evidence: ['command-exit', 'live', 'report'],
  },
  {
    id: 'P04-VERT-MANUAL-BLOCK', group: 'vertical', title: '纵向演示：负责人确认阻塞',
    layer: 'phase-acceptance', execution: 'manual', fr: ['FR-4'], acceptanceRefs: ['T39'],
    assertions: ['定向工具通过但负责人状态为 pending/rejected 时阶段结论为 fail，不能放行 P05', '确认解除必须由明确负责人提交并绑定当前 commit'],
    evidence: ['manual', 'report'],
  },
];

const DEFERRED_ITEMS: readonly P04FrozenItem[] = [
  {
    id: 'P04-POST-DURABLE', group: 'deferred', title: '后置：Pi Durable 生产引擎',
    layer: 'phase-acceptance', execution: 'postponed', fr: [], acceptanceRefs: ['T43', 'T44'], deferredStatus: 'postponed',
    assertions: ['Durable 不自动进入生产依赖；其独有能力须另行批准和验证，不以标准 Pi 或 mock 证据替代'], evidence: ['report'],
  },
  {
    id: 'P04-POST-CHAT-SANDBOX', group: 'deferred', title: '后置：Chat、桌面与强沙箱',
    layer: 'phase-acceptance', execution: 'postponed', fr: ['FR-4'], acceptanceRefs: [], deferredStatus: 'postponed',
    assertions: ['Chat、桌面、通知、发布和强 OS 沙箱不属于本阶段放行能力，保持 postponed'], evidence: ['report'],
  },
];

/** 冻结清单全量（FR 组 → 验收编号组 → 纵向演示组 → deferred 组）。 */
export const P04_FROZEN_ITEMS: readonly P04FrozenItem[] = [
  ...FR_ITEMS,
  ...ACCEPTANCE_ITEMS,
  ...VERTICAL_ITEMS,
  ...DEFERRED_ITEMS,
];

/** 必需检查（计入通过数）的冻结 ID 顺序：deferred 不在其中。 */
export const P04_REQUIRED_CHECK_IDS: readonly string[] = P04_FROZEN_ITEMS.filter(
  (item) => item.group !== 'deferred',
).map((item) => item.id);

/** deferred 项的冻结 ID（不参与 P04 已通过计数）。 */
export const P04_DEFERRED_IDS: readonly string[] = DEFERRED_ITEMS.map((item) => item.id);

const FROZEN_ITEM_BY_ID: ReadonlyMap<string, P04FrozenItem> = new Map(
  P04_FROZEN_ITEMS.map((item) => [item.id, item]),
);

/* ------------------------------------------------------------------ *
 * 清单校验
 * ------------------------------------------------------------------ */

export type P04ChecklistItem = {
  id: string;
  group: P04ItemGroup;
  title: string;
  layer: P04Layer;
  execution: P04ExecutionType;
  fr: string[];
  acceptanceRefs: string[];
  assertions: string[];
  evidence: string[];
  coverage?: P04Coverage;
  coverageNote?: string;
  deferredStatus?: P04DeferredStatus;
};

export type P04Checklist = {
  checklistVersion: number;
  phase: string;
  layers: string[];
  evidenceCategories: string[];
  countRule: string;
  items: P04ChecklistItem[];
};

function assertItemMatchesFrozen(raw: Record<string, unknown>, frozen: P04FrozenItem): P04ChecklistItem {
  const label = `items[${frozen.id}]`;
  assertAllowedKeys(raw, ITEM_ALLOWED_KEYS, label);

  if (raw.id !== frozen.id) {
    fail('invalid_config', `${label}.id 与冻结基线不一致：期望 ${frozen.id}，收到 ${String(raw.id)}`);
  }
  if (raw.group !== frozen.group) {
    fail('invalid_config', `${label}.group 与冻结基线不一致（不得改写检查归属）：期望 ${frozen.group}，收到 ${String(raw.group)}`);
  }
  if (raw.title !== frozen.title) {
    fail('invalid_config', `${label}.title 与冻结基线不一致：期望 ${frozen.title}，收到 ${String(raw.title)}`);
  }
  if (raw.layer !== frozen.layer) {
    fail(
      'invalid_config',
      `${label}.layer 与冻结基线不一致（不得降级/升格验证层次）：期望 ${frozen.layer}，收到 ${String(raw.layer)}`,
    );
  }
  if (raw.execution !== frozen.execution) {
    fail(
      'invalid_config',
      `${label}.execution 与冻结基线不一致（不得混淆离线/live/人工/后置执行类别）：期望 ${frozen.execution}，收到 ${String(raw.execution)}`,
    );
  }
  assertSameStringArray(raw.fr, frozen.fr, `${label}.fr`, '不得改写 FR 映射');
  assertSameStringArray(
    raw.acceptanceRefs,
    frozen.acceptanceRefs,
    `${label}.acceptanceRefs`,
    '不得改写验收编号映射',
  );
  assertSameStringArray(raw.assertions, frozen.assertions, `${label}.assertions`, '不得删减必需断言');
  assertSameStringArray(raw.evidence, frozen.evidence, `${label}.evidence`, '不得改写证据要求');

  if (frozen.coverage === 'partial') {
    if (raw.coverage !== 'partial') {
      fail('invalid_config', `${label}.coverage 必须保持 partial（T38 仅报告结构、T40 仅通用恢复决策，不得扩大声明范围）`);
    }
    if (raw.coverageNote !== frozen.coverageNote) {
      fail('invalid_config', `${label}.coverageNote 与冻结基线不一致（不得改写覆盖限制说明）`);
    }
  } else if (raw.coverage !== undefined || raw.coverageNote !== undefined) {
    fail('invalid_config', `${label} 不得新增 coverage/coverageNote（该检查为必需项，不得自我限定范围）`);
  }

  if (frozen.group === 'deferred') {
    if (raw.deferredStatus !== frozen.deferredStatus) {
      fail(
        'invalid_config',
        `${label}.deferredStatus 与冻结基线不一致（deferred 项只能显示 not_run/postponed，不得计入已通过）：期望 ${String(frozen.deferredStatus)}，收到 ${String(raw.deferredStatus)}`,
      );
    }
  } else if (raw.deferredStatus !== undefined) {
    fail('invalid_config', `${label} 不得携带 deferredStatus（必需项不得降级为后置/not_run）`);
  }

  return {
    id: frozen.id,
    group: frozen.group,
    title: frozen.title,
    layer: frozen.layer,
    execution: frozen.execution,
    fr: [...frozen.fr],
    acceptanceRefs: [...frozen.acceptanceRefs],
    assertions: [...frozen.assertions],
    evidence: [...frozen.evidence],
    ...(frozen.coverage !== undefined ? { coverage: frozen.coverage, coverageNote: frozen.coverageNote } : {}),
    ...(frozen.deferredStatus !== undefined ? { deferredStatus: frozen.deferredStatus } : {}),
  };
}

/**
 * 严格校验机器可读清单：未知/重复检查 ID、移除必需项、删减必需断言、改写 FR/T 映射、
 * 降级验证层次、改写证据类别、把 deferred 计入通过或新增自我限定范围一律拒绝（invalid_config）。
 */
export function validateP04Checklist(raw: unknown): P04Checklist {
  if (!isPlainObject(raw)) {
    fail('invalid_config', '检查清单必须是对象');
  }
  assertAllowedKeys(raw, CHECKLIST_ALLOWED_KEYS, '检查清单');

  if (raw.checklistVersion !== P04_CHECKLIST_VERSION) {
    fail(
      'invalid_config',
      `未知 checklistVersion：${String(raw.checklistVersion)}（本校验仅支持 ${P04_CHECKLIST_VERSION}）`,
    );
  }
  if (raw.phase !== 'P04') {
    fail('invalid_config', `phase 必须是 P04，收到：${String(raw.phase)}`);
  }
  assertSameStringArray(raw.layers, P04_LAYERS, 'layers', '不得改写验证层次词汇表');
  assertSameStringArray(
    raw.evidenceCategories,
    P04_EVIDENCE_CATEGORIES,
    'evidenceCategories',
    '不得改写证据类别词汇表',
  );
  if (raw.countRule !== P04_COUNT_RULE) {
    fail('invalid_config', 'countRule 与冻结基线不一致（不得改写通过计数规则/按测试数量判断覆盖）');
  }

  if (!Array.isArray(raw.items)) {
    fail('invalid_config', 'items 必须是数组');
  }
  const rawItems = raw.items as unknown[];
  const seen = new Set<string>();
  rawItems.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      fail('invalid_config', `items[${index}] 必须是对象`);
    }
    const id = entry.id;
    if (typeof id !== 'string' || !CHECK_ID_PATTERN.test(id)) {
      fail('invalid_config', `items[${index}].id 检查 ID 非法（稳定 ID 形如 P04-XXX-YYY）：${String(id)}`);
    }
    if (seen.has(id)) {
      fail('invalid_config', `检查清单含重复检查 ID：${id}`);
    }
    seen.add(id);
    if (!FROZEN_ITEM_BY_ID.has(id)) {
      fail('invalid_config', `未知检查 ID：${id}（清单必须与冻结基线一致，不得新增未知项）`);
    }
    const frozen = FROZEN_ITEM_BY_ID.get(id) as P04FrozenItem;
    assertItemMatchesFrozen(entry, frozen);
    const group = entry.group;
    if (frozen.group !== 'deferred') {
      if (!Array.isArray(entry.assertions) || entry.assertions.length === 0) {
        fail('invalid_config', `${id} 必须有非空必需断言（覆盖按必需断言判定）`);
      }
      if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
        fail('invalid_config', `${id} 必须有非空证据类别`);
      }
      if (!Array.isArray(entry.fr) || entry.fr.length === 0) {
        fail('invalid_config', `${id} 必须映射 FR-1～FR-4 至少一项`);
      }
    } else if (group !== 'deferred') {
      fail('invalid_config', `${id}.group 必须是 deferred`);
    }
    if (typeof entry.execution !== 'string' || !(P04_EXECUTION_TYPES as readonly string[]).includes(entry.execution)) {
      fail('invalid_config', `${id} 执行类别非法：${String(entry.execution)}`);
    }
    for (const ref of (entry.acceptanceRefs as unknown[]) ?? []) {
      if (typeof ref !== 'string' || !T_REF_PATTERN.test(ref)) {
        fail('invalid_config', `${id} 验收编号非法（形如 T13）：${String(ref)}`);
      }
    }
    for (const fr of (entry.fr as unknown[]) ?? []) {
      if (typeof fr !== 'string' || !FR_REF_PATTERN.test(fr)) {
        fail('invalid_config', `${id} FR 编号非法（FR-1～FR-4）：${String(fr)}`);
      }
    }
    for (const category of (entry.evidence as unknown[]) ?? []) {
      if (typeof category !== 'string' || !(P04_EVIDENCE_CATEGORIES as readonly string[]).includes(category)) {
        fail('invalid_config', `${id} 证据类别非法：${String(category)}`);
      }
    }
    if (entry.layer !== undefined && !(P04_LAYERS as readonly string[]).includes(entry.layer as string)) {
      fail('invalid_config', `${id} 验证层次非法：${String(entry.layer)}`);
    }
  });

  // 必需项集合必须与冻结基线完全一致：缺失即“试图减少必需项”。
  for (const frozen of P04_FROZEN_ITEMS) {
    if (!seen.has(frozen.id)) {
      fail(
        'invalid_config',
        `必需/既定检查 ${frozen.id} 被移除（试图减少必需项或隐藏范围声明），清单必须保留全部冻结检查`,
      );
    }
  }
  if (rawItems.length !== P04_FROZEN_ITEMS.length) {
    fail(
      'invalid_config',
      `检查清单必须恰好包含 ${P04_FROZEN_ITEMS.length} 项冻结检查，收到 ${rawItems.length} 项`,
    );
  }

  return {
    checklistVersion: P04_CHECKLIST_VERSION,
    phase: 'P04',
    layers: [...P04_LAYERS],
    evidenceCategories: [...P04_EVIDENCE_CATEGORIES],
    countRule: P04_COUNT_RULE,
    items: P04_FROZEN_ITEMS.map((frozen) => {
      const entry = rawItems.find((candidate) => (candidate as Record<string, unknown>).id === frozen.id);
      return assertItemMatchesFrozen(entry as Record<string, unknown>, frozen);
    }),
  };
}

/* ------------------------------------------------------------------ *
 * 配置校验
 * ------------------------------------------------------------------ */

export type P04AcceptanceTimeouts = {
  stepMs: number;
  overallMs: number;
};

export type P04AcceptanceConfig = {
  configVersion: number;
  checklist: string;
  reportRoot: string;
  requiredChecks: string[];
  toolchain: {
    packageManager: string;
    node: string;
    npm: string;
    lockfile: string;
  };
  timeouts: P04AcceptanceTimeouts;
  maxCommandOutputBytes: number;
  fakeIdentity: {
    provider: string;
    model: string;
    realModel: boolean;
    network: string;
  };
  tempResources: {
    git: string;
    sqlite: string;
    dataRoot: string;
    home: string;
    reusePrevious: boolean;
  };
  reportScope: {
    statuses: string[];
    includeEvidenceHash: boolean;
    includeManualChecklist: boolean;
    deferredCountsAsPassed: boolean;
  };
  plan: {
    phaseId: string;
    stepId: string;
    title: string;
    scope: string;
    version: string;
    contractDoc: string;
  };
};

function assertFrozenObject(raw: unknown, frozen: Record<string, unknown>, label: string): void {
  if (!isPlainObject(raw)) {
    fail('invalid_config', `${label} 必须是对象`);
  }
  assertAllowedKeys(raw, Object.keys(frozen), label);
  for (const [key, expected] of Object.entries(frozen)) {
    const actual = raw[key];
    if (Array.isArray(expected)) {
      assertSameStringArray(actual, expected as string[], `${label}.${key}`, '必须沿用冻结基线');
    } else if (typeof expected === 'boolean' || typeof expected === 'number') {
      if (actual !== expected) {
        fail('invalid_config', `${label}.${key} 与冻结基线不一致：期望 ${String(expected)}，收到 ${String(actual)}`);
      }
    } else if (actual !== expected) {
      fail(
        'invalid_config',
        `${label}.${key} 与冻结基线不一致：期望 ${String(expected)}，收到 ${String(actual)}`,
      );
    }
  }
}

/**
 * 严格校验验收配置：无效配置、重复/未知检查 ID、试图减少必需项（缺失/重排/顶替）、
 * 改写 npm/P01/P02 版本约束、非有限预算、非显式 Fake 身份、非临时资源、
 * 试图把 deferred/not_run 计入通过或引入业务版本表/凭据字段一律拒绝（invalid_config）。
 */
export function validateP04AcceptanceConfig(raw: unknown): P04AcceptanceConfig {
  if (!isPlainObject(raw)) {
    fail('invalid_config', '验收配置必须是对象');
  }
  assertAllowedKeys(raw, CONFIG_ALLOWED_KEYS, '验收配置');

  if (raw.configVersion !== P04_ACCEPT_CONFIG_VERSION) {
    fail(
      'invalid_config',
      `未知 configVersion：${String(raw.configVersion)}（本校验仅支持 ${P04_ACCEPT_CONFIG_VERSION}）`,
    );
  }

  const checklist = assertConfigRelativePath(raw.checklist, 'checklist');
  const reportRoot = assertConfigRelativePath(raw.reportRoot, 'reportRoot');

  // 必需检查：恰好为冻结清单（顺序固定）；缺失/重复/未知/deferred/重排一律拒绝。
  if (!Array.isArray(raw.requiredChecks)) {
    fail('invalid_config', 'requiredChecks 必须是有序检查 ID 数组');
  }
  const requiredChecks = raw.requiredChecks as unknown[];
  const seen = new Set<string>();
  requiredChecks.forEach((value, index) => {
    if (typeof value !== 'string' || !CHECK_ID_PATTERN.test(value)) {
      fail('invalid_config', `requiredChecks[${index}] 检查 ID 非法：${String(value)}`);
    }
    const id = value as string;
    if (P04_DEFERRED_IDS.includes(id)) {
      fail(
        'invalid_config',
        `requiredChecks[${index}] 是 deferred 检查（${id}）：live/Pi、强沙箱及后序能力不参与 P04 已通过计数，不得列入必需检查`,
      );
    }
    if (!P04_REQUIRED_CHECK_IDS.includes(id)) {
      fail('invalid_config', `requiredChecks[${index}] 是未知检查 ID：${id}`);
    }
    if (seen.has(id)) {
      fail('invalid_config', `requiredChecks 含重复检查 ID：${id}（不得重复/顶替必需检查）`);
    }
    seen.add(id);
    const expected = P04_REQUIRED_CHECK_IDS[index];
    if (expected === undefined || id !== expected) {
      fail(
        'invalid_config',
        `requiredChecks[${index}] 必须是 ${String(expected)}（顺序固定，不得移除/关闭/重排必需项），收到 ${id}`,
      );
    }
  });
  if (requiredChecks.length !== P04_REQUIRED_CHECK_IDS.length) {
    fail(
      'invalid_config',
      `requiredChecks 必须恰好包含 ${P04_REQUIRED_CHECK_IDS.length} 个必需检查（不得移除/关闭必需项），收到 ${requiredChecks.length} 个`,
    );
  }

  // 版本约束：沿用 npm 和 P01/P02 冻结约束，不得改写工具/包管理器/锁文件。
  assertFrozenObject(raw.toolchain, P04_TOOLCHAIN as unknown as Record<string, unknown>, 'toolchain');

  // 有限步骤/总时间预算与输出上限。
  if (!isPlainObject(raw.timeouts)) {
    fail('invalid_config', 'timeouts 必须是对象');
  }
  assertAllowedKeys(raw.timeouts, ['stepMs', 'overallMs'], 'timeouts');
  const timeouts: P04AcceptanceTimeouts = {
    stepMs: assertBoundedInt(raw.timeouts.stepMs, P04_ACCEPT_MIN_TIMEOUT_MS, P04_ACCEPT_MAX_TIMEOUT_MS, 'timeouts.stepMs'),
    overallMs: assertBoundedInt(raw.timeouts.overallMs, P04_ACCEPT_MIN_TIMEOUT_MS, P04_ACCEPT_MAX_TIMEOUT_MS, 'timeouts.overallMs'),
  };
  if (timeouts.overallMs < timeouts.stepMs) {
    fail('invalid_config', `overallMs 不得小于 stepMs（总时间须覆盖单步预算）：${timeouts.overallMs} < ${timeouts.stepMs}`);
  }
  const maxCommandOutputBytes = assertBoundedInt(
    raw.maxCommandOutputBytes,
    P04_ACCEPT_MIN_OUTPUT_BYTES,
    P04_ACCEPT_MAX_OUTPUT_BYTES,
    'maxCommandOutputBytes',
  );

  // 显式 Fake 身份：不得冒充真实模型/live。
  assertFrozenObject(raw.fakeIdentity, P04_FAKE_IDENTITY as unknown as Record<string, unknown>, 'fakeIdentity');

  // 临时资源：隔离临时资源，不复用上一次资源、不指向开发机路径。
  assertFrozenObject(raw.tempResources, P04_TEMP_RESOURCES as unknown as Record<string, unknown>, 'tempResources');

  // 报告范围：not_run/deferred 可见且不计入已通过数。
  assertFrozenObject(raw.reportScope, P04_REPORT_SCOPE as unknown as Record<string, unknown>, 'reportScope');

  if (!isPlainObject(raw.plan)) {
    fail('invalid_config', 'plan 必须是对象');
  }
  assertAllowedKeys(raw.plan, ['phaseId', 'stepId', 'title', 'scope', 'version', 'contractDoc'], 'plan');
  const plan = {
    phaseId: assertNonEmptyString(raw.plan.phaseId, 'plan.phaseId'),
    stepId: assertNonEmptyString(raw.plan.stepId, 'plan.stepId'),
    title: assertNonEmptyString(raw.plan.title, 'plan.title'),
    scope: assertNonEmptyString(raw.plan.scope, 'plan.scope'),
    version: assertNonEmptyString(raw.plan.version, 'plan.version'),
    contractDoc: assertConfigRelativePath(raw.plan.contractDoc, 'plan.contractDoc'),
  };

  return {
    configVersion: P04_ACCEPT_CONFIG_VERSION,
    checklist,
    reportRoot,
    requiredChecks: [...P04_REQUIRED_CHECK_IDS],
    toolchain: { ...P04_TOOLCHAIN },
    timeouts,
    maxCommandOutputBytes,
    fakeIdentity: { ...P04_FAKE_IDENTITY },
    tempResources: { ...P04_TEMP_RESOURCES },
    reportScope: {
      statuses: [...P04_REPORT_SCOPE.statuses],
      includeEvidenceHash: P04_REPORT_SCOPE.includeEvidenceHash,
      includeManualChecklist: P04_REPORT_SCOPE.includeManualChecklist,
      deferredCountsAsPassed: P04_REPORT_SCOPE.deferredCountsAsPassed,
    },
    plan,
  };
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_config', `${label} 必须是非空字符串`);
  }
  return value as string;
}

/* ------------------------------------------------------------------ *
 * 加载与汇总
 * ------------------------------------------------------------------ */

function loadJson(path: string, label: string): unknown {
  if (!existsSync(path)) {
    fail('invalid_config', `${label} 不存在：${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    fail('invalid_config', `${label} 不是合法 JSON：${path}`, (error as Error).message);
  }
  return parsed;
}

/** 从 JSON 文件加载并严格校验机器可读清单；文件缺失/不可解析同样 invalid_config。 */
export function loadP04Checklist(checklistPath = P04_CHECKLIST_PATH): P04Checklist {
  return validateP04Checklist(loadJson(checklistPath, '检查清单'));
}

/** 从 JSON 文件加载并严格校验验收配置；文件缺失/不可解析同样 invalid_config。 */
export function loadP04AcceptanceConfig(configPath = P04_ACCEPT_CONFIG_PATH): P04AcceptanceConfig {
  return validateP04AcceptanceConfig(loadJson(configPath, '验收配置'));
}

export type P04ChecklistSummary = {
  total: number;
  required: number;
  deferred: number;
  countedChecks: string[];
  deferredChecks: { id: string; status: P04DeferredStatus }[];
  layers: Record<string, number>;
};

/**
 * 清单汇总：deferred 项单列（not_run/postponed），只把必需项列入 countedChecks，
 * 供报告按必需断言判定覆盖，不按测试数量判断、不把 deferred 计入已通过数。
 */
export function summarizeP04Checklist(checklist: P04Checklist): P04ChecklistSummary {
  const countedChecks: string[] = [];
  const deferredChecks: { id: string; status: P04DeferredStatus }[] = [];
  const layers: Record<string, number> = {};
  for (const item of checklist.items) {
    layers[item.layer] = (layers[item.layer] ?? 0) + 1;
    if (item.group === 'deferred') {
      deferredChecks.push({ id: item.id, status: item.deferredStatus as P04DeferredStatus });
    } else {
      countedChecks.push(item.id);
    }
  }
  return {
    total: checklist.items.length,
    required: countedChecks.length,
    deferred: deferredChecks.length,
    countedChecks,
    deferredChecks,
    layers,
  };
}
