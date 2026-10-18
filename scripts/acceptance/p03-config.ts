/**
 * P03-10 / F-002 P03 阶段验收机器可读检查清单与受校验配置
 * （开发验收工具输入，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口）。
 *
 * 交付面（固定 FR、验收编号与证据要求的映射）：
 * - `acceptance/p03.checklist.json`：机器可读检查清单。每项有稳定 ID、FR 映射、
 *   验收编号（T 编号）映射、必需断言、证据类别与验证层次（unit / feature-integration /
 *   phase-acceptance）；完成、预算耗尽、人工阻塞、最终检查失败、仅收尾重试五个
 *   纵向演示单独成项；
 * - `acceptance/p03.config.json`：阶段验收配置（configVersion=1），包含 npm 与
 *   P01/P02 版本约束（Node/npm 精确版本、npm@10.9.3、package-lock.json）、有限
 *   步骤/总时间预算、命令输出上限、显式 Fake 身份、临时资源与报告范围；
 * - 本文件的冻结基线与 fail-closed 校验：无效配置、重复/未知检查 ID、试图减少
 *   或改写必需项（含删减断言、改写 T/FR 映射、降级层次、把 deferred 计入通过）
 *   一律拒绝（invalid_config）。
 *
 * 边界（PRD FR-3/约束）：
 * - 本配置是**验收工具输入**：不新增业务版本表，不构成第二套产品配置体系
 *   （schemaVersions/migrations/settings/database/credentials 等键一律拒绝）；
 * - live/Pi、强 OS 沙箱与后序能力（Chat/桌面/通知/用量平台/缓存收益）在清单中
 *   明确为 deferred（not_run 或 postponed），不参与 P03 已通过计数；
 * - T38 仅报告结构、T40 仅通用恢复决策（coverage=partial），不冒充真实模型汇总、
 *   加权缓存率或 Pi SDK 原生续接通过；
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

export const P03_CHECKLIST_VERSION = 1;
export const P03_ACCEPT_CONFIG_VERSION = 1;
export const P03_CHECKLIST_PATH = 'acceptance/p03.checklist.json';
export const P03_ACCEPT_CONFIG_PATH = 'acceptance/p03.config.json';

/** 验证层次词汇表：区分单元测试、Feature 集成与阶段验收。 */
export const P03_LAYERS = ['unit', 'feature-integration', 'phase-acceptance'] as const;
export type P03Layer = (typeof P03_LAYERS)[number];

/** 证据类别词汇表：每项必需断言对应的证据形态。 */
export const P03_EVIDENCE_CATEGORIES = [
  'command-exit',
  'sqlite',
  'git',
  'process',
  'artifact',
  'report',
  'manifest',
] as const;
export type P03EvidenceCategory = (typeof P03_EVIDENCE_CATEGORIES)[number];

export const P03_FR_IDS = ['FR-1', 'FR-2', 'FR-3'] as const;

export type P03ItemGroup = 'fr' | 'acceptance' | 'vertical' | 'deferred';
export type P03DeferredStatus = 'not_run' | 'postponed';
export type P03Coverage = 'partial';

/** 覆盖判定规则（冻结文案）：不按测试数量判断覆盖。 */
export const P03_COUNT_RULE =
  '必需项全部 pass 才算通过；deferred 项显示 not_run 或 postponed，不参与 P03 已通过计数；覆盖按必需断言判定，不按测试数量判断';

/**
 * 沿用 npm 与 P01/P02 冻结的版本约束（root package.json engines/packageManager、
 * package-lock.json）；P03 不另立包管理器或工具版本。
 */
export const P03_TOOLCHAIN = {
  packageManager: 'npm@10.9.3',
  node: '22.19.0',
  npm: '10.9.3',
  lockfile: 'package-lock.json',
} as const;

/** 有限步骤/总时间预算的合法范围（有限正毫秒）。 */
export const P03_ACCEPT_MIN_TIMEOUT_MS = 1_000;
export const P03_ACCEPT_MAX_TIMEOUT_MS = 7_200_000;
/** 命令输出上限的合法范围（字节）。 */
export const P03_ACCEPT_MIN_OUTPUT_BYTES = 1_024;
export const P03_ACCEPT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** 显式 Fake 身份（冻结）：P03 确定性验收不调用真实模型/live。 */
export const P03_FAKE_IDENTITY = {
  provider: 'fake-provider',
  model: 'fake-model',
  realModel: false,
  network: 'denied',
} as const;

/** 临时资源声明（冻结）：全部为隔离临时资源，不复用上一次资源。 */
export const P03_TEMP_RESOURCES = {
  git: 'temp',
  sqlite: 'temp',
  dataRoot: 'temp',
  home: 'temp',
  reusePrevious: false,
} as const;

/** 报告范围（冻结）：not_run/deferred 可见且不计入已通过数。 */
export const P03_REPORT_SCOPE = {
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
const CHECK_ID_PATTERN = /^P03-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const T_REF_PATTERN = /^[A-Z]\d{2}$/;
const FR_REF_PATTERN = /^FR-[1-3]$/;

export type P03AcceptErrorKind = 'invalid_config';

export class P03AcceptError extends Error {
  readonly kind: P03AcceptErrorKind;
  readonly detail?: string;

  constructor(kind: P03AcceptErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'P03AcceptError';
    this.kind = kind;
    this.detail = detail;
  }
}

function fail(kind: P03AcceptErrorKind, message: string, detail?: string): never {
  throw new P03AcceptError(kind, message, detail);
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

export type P03FrozenItem = {
  readonly id: string;
  readonly group: P03ItemGroup;
  readonly title: string;
  readonly layer: P03Layer;
  readonly fr: readonly string[];
  readonly acceptanceRefs: readonly string[];
  readonly assertions: readonly string[];
  readonly evidence: readonly P03EvidenceCategory[];
  readonly coverage?: P03Coverage;
  readonly coverageNote?: string;
  readonly deferredStatus?: P03DeferredStatus;
};

/** FR 组：FR-1～FR-3 的正常与关键负例（阶段验收层）。 */
const FR_ITEMS: readonly P03FrozenItem[] = [
  {
    id: 'P03-FR1-CLOSED-LOOP',
    group: 'fr',
    title: 'FR-1 正常：确定性执行闭环纵向验收',
    layer: 'phase-acceptance',
    fr: ['FR-1'],
    acceptanceRefs: ['T02', 'T04', 'T08'],
    assertions: [
      '经正式构建 CLI/Host/Core 完成计划导入、审批、执行授权、调度、实现、验收、返工与提交闭环，逐项有真实状态断言',
      '单元测试、Feature 集成与阶段验收分层记录，不以测试数量充当需求满足',
    ],
    evidence: ['command-exit', 'sqlite', 'git', 'report'],
  },
  {
    id: 'P03-FR1-NEG-INTEGRITY',
    group: 'fr',
    title: 'FR-1 关键负例：失败/未运行/真假执行混淆不冒充通过',
    layer: 'phase-acceptance',
    fr: ['FR-1'],
    acceptanceRefs: ['T07'],
    assertions: [
      '准备失败、未运行、缺输出或真假执行混淆记 fail 或 not_run',
      '不手改 SQLite、不删负例、不借后序功能过关；重复执行不依赖上次资源',
    ],
    evidence: ['command-exit', 'report'],
  },
  {
    id: 'P03-FR2-MATRIX',
    group: 'fr',
    title: 'FR-2 正常：实战负例场景覆盖矩阵与清理',
    layer: 'phase-acceptance',
    fr: ['FR-2'],
    acceptanceRefs: ['T03', 'T06', 'T13', 'T39'],
    assertions: [
      '预算竞争、过期批准/人工阻塞、Runtime 异常、大输入、局部测试选择、最终失败、提交/停止/恢复故障注入均有场景矩阵与实际失败原因',
      'cleanup manifest 与支持限制明确；清理前确认受管进程组消失，生产失败保留 worktree 与临时测试夹具最终清理区分',
    ],
    evidence: ['sqlite', 'process', 'manifest'],
  },
  {
    id: 'P03-FR2-NEG-GUARDRAILS',
    group: 'fr',
    title: 'FR-2 关键负例：机器全绿不越过人工与终态门槛',
    layer: 'phase-acceptance',
    fr: ['FR-2'],
    acceptanceRefs: ['T36', 'T39'],
    assertions: [
      '人工未批即使全绿也不能 passed；全部 Task 通过但最终失败时不能 completed',
      '停止不确定仍隔离；服务端/限流/认证异常不误扣代码返工次数或丢失现场',
    ],
    evidence: ['sqlite', 'git'],
  },
  {
    id: 'P03-FR3-REPORT',
    group: 'fr',
    title: 'FR-3 正常：可审阅完整执行报告',
    layer: 'phase-acceptance',
    fr: ['FR-3'],
    acceptanceRefs: ['T38'],
    assertions: [
      '报告含幂等完整 Task 表、Attempt 历史、最终检查/审批/交付状态、下一步操作与人工验收清单',
      '同一 Task 最近状态与累计尝试分开，失败和取消不丢失；报告从状态/证据生成而非拼接历次报告',
    ],
    evidence: ['report'],
  },
  {
    id: 'P03-FR3-NEG-REPORT-INTEGRITY',
    group: 'fr',
    title: 'FR-3 关键负例：报告不虚构历史与收益',
    layer: 'phase-acceptance',
    fr: ['FR-3'],
    acceptanceRefs: ['T38'],
    assertions: [
      '缺历史字段保留并标 partial，重复生成不重复计数',
      '报告不自动解除人审或反写通过；Fake 用量不当真实用量，未知 token/cache/cost 记 unknown',
    ],
    evidence: ['report'],
  },
];

/**
 * 验收编号组：T02/T03/T04/T06/T07/T08/T13/T21/T24/T25/T26/T29/T31、T35～T37/T39
 * 全覆盖；T38 仅报告结构（coverage=partial），T40 仅通用恢复决策（coverage=partial）。
 */
const ACCEPTANCE_ITEMS: readonly P03FrozenItem[] = [
  {
    id: 'P03-T02',
    group: 'acceptance',
    title: 'T02 DAG 依赖门禁',
    layer: 'feature-integration',
    fr: ['FR-1'],
    acceptanceRefs: ['T02'],
    assertions: [
      'DAG 缺失依赖/环拒绝，依赖未 passed 不解锁后继',
      '任务选择轨迹与状态测试证据可核对',
    ],
    evidence: ['sqlite', 'manifest'],
  },
  {
    id: 'P03-T03',
    group: 'acceptance',
    title: 'T03 认领原子性与重复请求',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T03'],
    assertions: [
      '原子认领、并发冲突、重复请求与状态事件在同一事务内一致',
      '真实 SQLite 竞争与回滚证据可核对',
    ],
    evidence: ['sqlite'],
  },
  {
    id: 'P03-T04',
    group: 'acceptance',
    title: 'T04 增量返工与次数上限',
    layer: 'feature-integration',
    fr: ['FR-1'],
    acceptanceRefs: ['T04'],
    assertions: [
      '失败增量返工并受最多次数限制，skipped 不算全部成功',
      'Attempt 链、失败证据与 blocked 后继可核对',
    ],
    evidence: ['sqlite', 'artifact'],
  },
  {
    id: 'P03-T06',
    group: 'acceptance',
    title: 'T06 超时/取消/崩溃后旧进程核对',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T06'],
    assertions: [
      '超时/取消/Host 崩溃后先核对旧进程再重试，不确认停止不释放占用',
      '真实子进程树与 workspace 占用证据可核对',
    ],
    evidence: ['process', 'sqlite'],
  },
  {
    id: 'P03-T07',
    group: 'acceptance',
    title: 'T07 Runtime 完成不等于通过',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T07'],
    assertions: [
      'Runtime 完成不等于 Task passed；空检查/篡改门槛不自动成功',
      'Verifier 命令与代码摘要证据可核对',
    ],
    evidence: ['command-exit', 'artifact'],
  },
  {
    id: 'P03-T08',
    group: 'acceptance',
    title: 'T08 worktree 现场保护与幂等',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T08'],
    assertions: [
      'worktree 基线、失败/部分完成现场保留、幂等复用；错误目录/分支拒绝、脏目录不清理',
      '真实临时 Git 仓库 HEAD 与 operation 回执可核对',
    ],
    evidence: ['git', 'command-exit'],
  },
  {
    id: 'P03-T13',
    group: 'acceptance',
    title: 'T13 预算与停止原因区分',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T13'],
    assertions: [
      '时间/次数预算、未知费用与限流告警分开记录并区分错误类别',
      '停止原因与预算快照证据可核对',
    ],
    evidence: ['sqlite', 'artifact'],
  },
  {
    id: 'P03-T21',
    group: 'acceptance',
    title: 'T21 累计额度与幂等重入',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T21'],
    assertions: [
      '成功 Run 占用累计额度，重复进入/重启/增额不清父预算',
      '事务计数、workKey 去重与授权预算版本证据可核对',
    ],
    evidence: ['sqlite'],
  },
  {
    id: 'P03-T24',
    group: 'acceptance',
    title: 'T24 Task 策略复制与来源',
    layer: 'unit',
    fr: ['FR-2'],
    acceptanceRefs: ['T24'],
    assertions: [
      'Task 策略完整复制，默认更新不追溯已有 Task，用户覆盖产生独立来源',
      '重新应用默认需预览；策略与来源记录可核对',
    ],
    evidence: ['sqlite', 'artifact'],
  },
  {
    id: 'P03-T25',
    group: 'acceptance',
    title: 'T25 活动 Attempt 策略快照保护',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T25'],
    assertions: [
      '活动 Attempt 禁止改策略，返工换模型不清预算',
      '前后 Attempt 独立快照脱敏且不可变，累计计数可核对',
    ],
    evidence: ['sqlite', 'artifact'],
  },
  {
    id: 'P03-T26',
    group: 'acceptance',
    title: 'T26 CAS 冲突与过期审批',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T26'],
    assertions: [
      '当前配置 CAS 冲突拒绝，计划修改不得越过活动执行，过期审批失效',
      '并发事务与恢复测试证据可核对',
    ],
    evidence: ['sqlite'],
  },
  {
    id: 'P03-T29',
    group: 'acceptance',
    title: 'T29 单并发竞争与资源串行',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T29'],
    assertions: [
      '默认单并发下竞争认领只有一个有效 owner/version，独立取消与事件归属不跨任务污染',
      'Git 资源串行，未验收并发值拒绝',
    ],
    evidence: ['sqlite', 'process'],
  },
  {
    id: 'P03-T31',
    group: 'acceptance',
    title: 'T31 预览失效与无待办',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T31'],
    assertions: [
      '执行预览后输入变化返回 preview_stale，范围外依赖未满足或无待办返回 no_work',
      '不静默扩大范围，输入快照证据可核对',
    ],
    evidence: ['sqlite', 'artifact'],
  },
  {
    id: 'P03-T35',
    group: 'acceptance',
    title: 'T35 局部测试选择与安全回退',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T35'],
    assertions: [
      '局部测试选择走已授权检查定义，记录选择理由、argv/cwd、timeout、退出码与结果制品',
      '候选缺失/过期、越界、符号链接、参数注入、零测试、多模块漏选与共享配置修改按策略回退或拒绝，无可信回退不得通过',
    ],
    evidence: ['artifact', 'command-exit'],
  },
  {
    id: 'P03-T36',
    group: 'acceptance',
    title: 'T36 最终验收失败与仅收尾重试',
    layer: 'feature-integration',
    fr: ['FR-1', 'FR-2'],
    acceptanceRefs: ['T36'],
    assertions: [
      'Task 通过与最终验收失败分离，显式新 Run 仅重试最终阶段',
      '不再次调用编码 Runtime；代码变化使旧证据失效；最终检查仍受预算限制',
    ],
    evidence: ['sqlite', 'git', 'command-exit'],
  },
  {
    id: 'P03-T37',
    group: 'acceptance',
    title: 'T37 稳定指导与动态输入分离',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T37'],
    assertions: [
      '稳定指导与动态文件输入分离，历史增长不膨胀提示词',
      '必需 acceptance 始终可读，引用摘要固定；缓存收益不以静态测试宣称',
    ],
    evidence: ['artifact', 'manifest'],
  },
  {
    id: 'P03-T38',
    group: 'acceptance',
    title: 'T38 报告结构（仅结构）',
    layer: 'unit',
    fr: ['FR-3'],
    acceptanceRefs: ['T38'],
    coverage: 'partial',
    coverageNote: '仅报告结构：完整 Task 视图、尝试去重与汇总字段结构；真实模型汇总/加权缓存率由 P04/P07 兑现，不在 P03 通过范围',
    assertions: [
      '报告结构含完整 Task 视图、尝试去重与汇总字段，重复生成不重复计数',
      '缺失值标 unknown/partial，不生成真实模型收益或加权缓存率结论（仅报告结构）',
    ],
    evidence: ['report'],
  },
  {
    id: 'P03-T39',
    group: 'acceptance',
    title: 'T39 人工阻塞优先于机器成功',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T39'],
    assertions: [
      '人工阻塞优先于机器成功，脚本 passed/Agent 自报不能放行',
      '迟到成功与新增阻塞竞争按事务重新核验；不增返工计数，批准绑定代码摘要，解除不重复编码',
    ],
    evidence: ['sqlite', 'artifact'],
  },
  {
    id: 'P03-T40',
    group: 'acceptance',
    title: 'T40 通用恢复决策（仅通用）',
    layer: 'feature-integration',
    fr: ['FR-2'],
    acceptanceRefs: ['T40'],
    coverage: 'partial',
    coverageNote: '仅通用恢复决策：同 Task 续接/新 Attempt/拒绝复用的 Core 决策与活跃旧进程拒绝重叠；Pi SDK 原生续接、换模型与原生检查点在 P04 验证，不在 P03 通过范围',
    assertions: [
      '同 Task 续接/新 Attempt/拒绝复用的通用恢复决策与活跃旧进程拒绝重叠可核对（仅通用恢复决策）',
      '历史与流/快照不重复计量，来源档案不变；不冒充 Pi SDK 原生续接通过',
    ],
    evidence: ['sqlite', 'process'],
  },
];

/** 五个必需纵向演示（完成、预算耗尽、人工阻塞、最终检查失败、仅收尾重试）。 */
const VERTICAL_ITEMS: readonly P03FrozenItem[] = [
  {
    id: 'P03-VERT-COMPLETE',
    group: 'vertical',
    title: '纵向演示：完成闭环',
    layer: 'phase-acceptance',
    fr: ['FR-1'],
    acceptanceRefs: ['T04', 'T07', 'T08'],
    assertions: [
      '三 Task 链首项通过、第二项首次真实检查失败后增量返工、第三项在前项有效通过后启动，最终执行 Feature 全量门禁与收尾提交',
      'Task/Feature/Run/Git 事实一致；Fake completed 不直接放行',
    ],
    evidence: ['sqlite', 'git', 'command-exit'],
  },
  {
    id: 'P03-VERT-BUDGET-EXHAUSTED',
    group: 'vertical',
    title: '纵向演示：预算耗尽',
    layer: 'phase-acceptance',
    fr: ['FR-2'],
    acceptanceRefs: ['T13', 'T21'],
    assertions: [
      '次数/时间预算耗尽后拒绝新增工作，停止原因与预算快照可核对',
      '累计预算不因重开数据库、新 Run 或换策略清零',
    ],
    evidence: ['sqlite'],
  },
  {
    id: 'P03-VERT-MANUAL-BLOCK',
    group: 'vertical',
    title: '纵向演示：人工阻塞',
    layer: 'phase-acceptance',
    fr: ['FR-2'],
    acceptanceRefs: ['T39'],
    assertions: [
      '必需人审未批或显式阻塞时，即使检查全绿也不 passed、不放行后继、不 completed',
      '等待不扣代码返工次数；解除需授权并绑定代码摘要',
    ],
    evidence: ['sqlite', 'artifact'],
  },
  {
    id: 'P03-VERT-FINAL-FAIL',
    group: 'vertical',
    title: '纵向演示：最终检查失败',
    layer: 'phase-acceptance',
    fr: ['FR-1', 'FR-2'],
    acceptanceRefs: ['T36', 'T07'],
    assertions: [
      '全部 Task 有效通过后真实 Feature 全量检查失败，Feature 非 completed，Run 保存最终阶段失败',
      'Task 历史与有效证据保留，Git/SQLite/报告事实一致',
    ],
    evidence: ['command-exit', 'sqlite', 'git'],
  },
  {
    id: 'P03-VERT-RETRY-FINAL',
    group: 'vertical',
    title: '纵向演示：仅收尾重试',
    layer: 'phase-acceptance',
    fr: ['FR-1'],
    acceptanceRefs: ['T36'],
    assertions: [
      '显式 retryFinal 在父授权 Batch 内创建受限新 Run，旧终态 Run 不复活，FakeRuntime 启动数增量为零',
      '收尾提交失败仅重试该步骤并核对已有 operation，不重复编码或提交',
    ],
    evidence: ['sqlite', 'command-exit'],
  },
];

/**
 * deferred 组：live/Pi、强 OS 沙箱与后序能力不在本期通过范围；
 * 显示 not_run 或 postponed，不参与 P03 已通过计数，不得列入 requiredChecks。
 */
const DEFERRED_ITEMS: readonly P03FrozenItem[] = [
  {
    id: 'P03-OOS-LIVE-PI',
    group: 'deferred',
    title: '范围外：真实 Pi/live 验收',
    layer: 'phase-acceptance',
    fr: [],
    acceptanceRefs: ['T40'],
    deferredStatus: 'not_run',
    assertions: [
      '真实 Pi/live、真实凭据与真实模型用量验收不在本期通过范围，未运行显示 not_run，不折算已通过',
    ],
    evidence: ['report'],
  },
  {
    id: 'P03-OOS-STRONG-SANDBOX',
    group: 'deferred',
    title: '范围外：强 OS 沙箱',
    layer: 'phase-acceptance',
    fr: [],
    acceptanceRefs: [],
    deferredStatus: 'postponed',
    assertions: [
      '强 OS 沙箱与任意凭据隔离不在本期支持范围，可信项目模式边界如实呈现并明确后置',
    ],
    evidence: ['report'],
  },
  {
    id: 'P03-OOS-LATER-CAPABILITIES',
    group: 'deferred',
    title: '范围外：后序能力（用量/缓存/Chat/桌面/通知/发布）',
    layer: 'phase-acceptance',
    fr: [],
    acceptanceRefs: ['T38'],
    deferredStatus: 'postponed',
    assertions: [
      '真实模型汇总、加权缓存率、Token/费用收益及 Chat/桌面/通知/发布等后序能力明确后置，不以 Fake 或测试数量宣称通过',
    ],
    evidence: ['report'],
  },
];

/** 冻结清单全量（FR 组 → 验收编号组 → 纵向演示组 → deferred 组）。 */
export const P03_FROZEN_ITEMS: readonly P03FrozenItem[] = [
  ...FR_ITEMS,
  ...ACCEPTANCE_ITEMS,
  ...VERTICAL_ITEMS,
  ...DEFERRED_ITEMS,
];

/** 必需检查（计入通过数）的冻结 ID 顺序：deferred 不在其中。 */
export const P03_REQUIRED_CHECK_IDS: readonly string[] = P03_FROZEN_ITEMS.filter(
  (item) => item.group !== 'deferred',
).map((item) => item.id);

/** deferred 项的冻结 ID（不参与 P03 已通过计数）。 */
export const P03_DEFERRED_IDS: readonly string[] = DEFERRED_ITEMS.map((item) => item.id);

const FROZEN_ITEM_BY_ID: ReadonlyMap<string, P03FrozenItem> = new Map(
  P03_FROZEN_ITEMS.map((item) => [item.id, item]),
);

/* ------------------------------------------------------------------ *
 * 清单校验
 * ------------------------------------------------------------------ */

export type P03ChecklistItem = {
  id: string;
  group: P03ItemGroup;
  title: string;
  layer: P03Layer;
  fr: string[];
  acceptanceRefs: string[];
  assertions: string[];
  evidence: string[];
  coverage?: P03Coverage;
  coverageNote?: string;
  deferredStatus?: P03DeferredStatus;
};

export type P03Checklist = {
  checklistVersion: number;
  phase: string;
  layers: string[];
  evidenceCategories: string[];
  countRule: string;
  items: P03ChecklistItem[];
};

function assertItemMatchesFrozen(raw: Record<string, unknown>, frozen: P03FrozenItem): P03ChecklistItem {
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
export function validateP03Checklist(raw: unknown): P03Checklist {
  if (!isPlainObject(raw)) {
    fail('invalid_config', '检查清单必须是对象');
  }
  assertAllowedKeys(raw, CHECKLIST_ALLOWED_KEYS, '检查清单');

  if (raw.checklistVersion !== P03_CHECKLIST_VERSION) {
    fail(
      'invalid_config',
      `未知 checklistVersion：${String(raw.checklistVersion)}（本校验仅支持 ${P03_CHECKLIST_VERSION}）`,
    );
  }
  if (raw.phase !== 'P03') {
    fail('invalid_config', `phase 必须是 P03，收到：${String(raw.phase)}`);
  }
  assertSameStringArray(raw.layers, P03_LAYERS, 'layers', '不得改写验证层次词汇表');
  assertSameStringArray(
    raw.evidenceCategories,
    P03_EVIDENCE_CATEGORIES,
    'evidenceCategories',
    '不得改写证据类别词汇表',
  );
  if (raw.countRule !== P03_COUNT_RULE) {
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
      fail('invalid_config', `items[${index}].id 检查 ID 非法（稳定 ID 形如 P03-XXX-YYY）：${String(id)}`);
    }
    if (seen.has(id)) {
      fail('invalid_config', `检查清单含重复检查 ID：${id}`);
    }
    seen.add(id);
    if (!FROZEN_ITEM_BY_ID.has(id)) {
      fail('invalid_config', `未知检查 ID：${id}（清单必须与冻结基线一致，不得新增未知项）`);
    }
    const frozen = FROZEN_ITEM_BY_ID.get(id) as P03FrozenItem;
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
        fail('invalid_config', `${id} 必须映射 FR-1～FR-3 至少一项`);
      }
    } else if (group !== 'deferred') {
      fail('invalid_config', `${id}.group 必须是 deferred`);
    }
    for (const ref of (entry.acceptanceRefs as unknown[]) ?? []) {
      if (typeof ref !== 'string' || !T_REF_PATTERN.test(ref)) {
        fail('invalid_config', `${id} 验收编号非法（形如 T13）：${String(ref)}`);
      }
    }
    for (const fr of (entry.fr as unknown[]) ?? []) {
      if (typeof fr !== 'string' || !FR_REF_PATTERN.test(fr)) {
        fail('invalid_config', `${id} FR 编号非法（FR-1～FR-3）：${String(fr)}`);
      }
    }
    for (const category of (entry.evidence as unknown[]) ?? []) {
      if (typeof category !== 'string' || !(P03_EVIDENCE_CATEGORIES as readonly string[]).includes(category)) {
        fail('invalid_config', `${id} 证据类别非法：${String(category)}`);
      }
    }
    if (entry.layer !== undefined && !(P03_LAYERS as readonly string[]).includes(entry.layer as string)) {
      fail('invalid_config', `${id} 验证层次非法：${String(entry.layer)}`);
    }
  });

  // 必需项集合必须与冻结基线完全一致：缺失即“试图减少必需项”。
  for (const frozen of P03_FROZEN_ITEMS) {
    if (!seen.has(frozen.id)) {
      fail(
        'invalid_config',
        `必需/既定检查 ${frozen.id} 被移除（试图减少必需项或隐藏范围声明），清单必须保留全部冻结检查`,
      );
    }
  }
  if (rawItems.length !== P03_FROZEN_ITEMS.length) {
    fail(
      'invalid_config',
      `检查清单必须恰好包含 ${P03_FROZEN_ITEMS.length} 项冻结检查，收到 ${rawItems.length} 项`,
    );
  }

  return {
    checklistVersion: P03_CHECKLIST_VERSION,
    phase: 'P03',
    layers: [...P03_LAYERS],
    evidenceCategories: [...P03_EVIDENCE_CATEGORIES],
    countRule: P03_COUNT_RULE,
    items: P03_FROZEN_ITEMS.map((frozen) => {
      const entry = rawItems.find((candidate) => (candidate as Record<string, unknown>).id === frozen.id);
      return assertItemMatchesFrozen(entry as Record<string, unknown>, frozen);
    }),
  };
}

/* ------------------------------------------------------------------ *
 * 配置校验
 * ------------------------------------------------------------------ */

export type P03AcceptanceTimeouts = {
  stepMs: number;
  overallMs: number;
};

export type P03AcceptanceConfig = {
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
  timeouts: P03AcceptanceTimeouts;
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
export function validateP03AcceptanceConfig(raw: unknown): P03AcceptanceConfig {
  if (!isPlainObject(raw)) {
    fail('invalid_config', '验收配置必须是对象');
  }
  assertAllowedKeys(raw, CONFIG_ALLOWED_KEYS, '验收配置');

  if (raw.configVersion !== P03_ACCEPT_CONFIG_VERSION) {
    fail(
      'invalid_config',
      `未知 configVersion：${String(raw.configVersion)}（本校验仅支持 ${P03_ACCEPT_CONFIG_VERSION}）`,
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
    if (P03_DEFERRED_IDS.includes(id)) {
      fail(
        'invalid_config',
        `requiredChecks[${index}] 是 deferred 检查（${id}）：live/Pi、强沙箱及后序能力不参与 P03 已通过计数，不得列入必需检查`,
      );
    }
    if (!P03_REQUIRED_CHECK_IDS.includes(id)) {
      fail('invalid_config', `requiredChecks[${index}] 是未知检查 ID：${id}`);
    }
    if (seen.has(id)) {
      fail('invalid_config', `requiredChecks 含重复检查 ID：${id}（不得重复/顶替必需检查）`);
    }
    seen.add(id);
    const expected = P03_REQUIRED_CHECK_IDS[index];
    if (expected === undefined || id !== expected) {
      fail(
        'invalid_config',
        `requiredChecks[${index}] 必须是 ${String(expected)}（顺序固定，不得移除/关闭/重排必需项），收到 ${id}`,
      );
    }
  });
  if (requiredChecks.length !== P03_REQUIRED_CHECK_IDS.length) {
    fail(
      'invalid_config',
      `requiredChecks 必须恰好包含 ${P03_REQUIRED_CHECK_IDS.length} 个必需检查（不得移除/关闭必需项），收到 ${requiredChecks.length} 个`,
    );
  }

  // 版本约束：沿用 npm 和 P01/P02 冻结约束，不得改写工具/包管理器/锁文件。
  assertFrozenObject(raw.toolchain, P03_TOOLCHAIN as unknown as Record<string, unknown>, 'toolchain');

  // 有限步骤/总时间预算与输出上限。
  if (!isPlainObject(raw.timeouts)) {
    fail('invalid_config', 'timeouts 必须是对象');
  }
  assertAllowedKeys(raw.timeouts, ['stepMs', 'overallMs'], 'timeouts');
  const timeouts: P03AcceptanceTimeouts = {
    stepMs: assertBoundedInt(raw.timeouts.stepMs, P03_ACCEPT_MIN_TIMEOUT_MS, P03_ACCEPT_MAX_TIMEOUT_MS, 'timeouts.stepMs'),
    overallMs: assertBoundedInt(raw.timeouts.overallMs, P03_ACCEPT_MIN_TIMEOUT_MS, P03_ACCEPT_MAX_TIMEOUT_MS, 'timeouts.overallMs'),
  };
  if (timeouts.overallMs < timeouts.stepMs) {
    fail('invalid_config', `overallMs 不得小于 stepMs（总时间须覆盖单步预算）：${timeouts.overallMs} < ${timeouts.stepMs}`);
  }
  const maxCommandOutputBytes = assertBoundedInt(
    raw.maxCommandOutputBytes,
    P03_ACCEPT_MIN_OUTPUT_BYTES,
    P03_ACCEPT_MAX_OUTPUT_BYTES,
    'maxCommandOutputBytes',
  );

  // 显式 Fake 身份：不得冒充真实模型/live。
  assertFrozenObject(raw.fakeIdentity, P03_FAKE_IDENTITY as unknown as Record<string, unknown>, 'fakeIdentity');

  // 临时资源：隔离临时资源，不复用上一次资源、不指向开发机路径。
  assertFrozenObject(raw.tempResources, P03_TEMP_RESOURCES as unknown as Record<string, unknown>, 'tempResources');

  // 报告范围：not_run/deferred 可见且不计入已通过数。
  assertFrozenObject(raw.reportScope, P03_REPORT_SCOPE as unknown as Record<string, unknown>, 'reportScope');

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
    configVersion: P03_ACCEPT_CONFIG_VERSION,
    checklist,
    reportRoot,
    requiredChecks: [...P03_REQUIRED_CHECK_IDS],
    toolchain: { ...P03_TOOLCHAIN },
    timeouts,
    maxCommandOutputBytes,
    fakeIdentity: { ...P03_FAKE_IDENTITY },
    tempResources: { ...P03_TEMP_RESOURCES },
    reportScope: {
      statuses: [...P03_REPORT_SCOPE.statuses],
      includeEvidenceHash: P03_REPORT_SCOPE.includeEvidenceHash,
      includeManualChecklist: P03_REPORT_SCOPE.includeManualChecklist,
      deferredCountsAsPassed: P03_REPORT_SCOPE.deferredCountsAsPassed,
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
export function loadP03Checklist(checklistPath = P03_CHECKLIST_PATH): P03Checklist {
  return validateP03Checklist(loadJson(checklistPath, '检查清单'));
}

/** 从 JSON 文件加载并严格校验验收配置；文件缺失/不可解析同样 invalid_config。 */
export function loadP03AcceptanceConfig(configPath = P03_ACCEPT_CONFIG_PATH): P03AcceptanceConfig {
  return validateP03AcceptanceConfig(loadJson(configPath, '验收配置'));
}

export type P03ChecklistSummary = {
  total: number;
  required: number;
  deferred: number;
  countedChecks: string[];
  deferredChecks: { id: string; status: P03DeferredStatus }[];
  layers: Record<string, number>;
};

/**
 * 清单汇总：deferred 项单列（not_run/postponed），只把必需项列入 countedChecks，
 * 供报告按必需断言判定覆盖，不按测试数量判断、不把 deferred 计入已通过数。
 */
export function summarizeP03Checklist(checklist: P03Checklist): P03ChecklistSummary {
  const countedChecks: string[] = [];
  const deferredChecks: { id: string; status: P03DeferredStatus }[] = [];
  const layers: Record<string, number> = {};
  for (const item of checklist.items) {
    layers[item.layer] = (layers[item.layer] ?? 0) + 1;
    if (item.group === 'deferred') {
      deferredChecks.push({ id: item.id, status: item.deferredStatus as P03DeferredStatus });
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
