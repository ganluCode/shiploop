/**
 * P08-4 / F-001 P08 一期总验收契约：冻结清单、检查配置、入口契约与证据语义
 * （开发验收工具，不是 ShipLoop 产品能力，不进 packages/，不提供 Host/CLI 接口）。
 *
 * 复用 P01～P07 已建立的验收契约机制（scripts/acceptance/p07-config.ts、
 * p06-config.ts），按 input/p08-acceptance.md §2、§3 与 execution-contract.md
 * 冻结 P08 总验收的版本化输入契约：
 *
 * - **六个层次**：清单逐项表达代码交付（前序 P08-1～P08-3 交付报告为前置输入）、
 *   Task 局部验证、Feature 门禁、Phase 集成、Live 与人工确认；每个层次都必须被
 *   必需检查覆盖，缺项、重复身份、未知版本、空检查集合、删减断言、改写执行类别
 *   或层次一律拒绝，不以测试数量证明需求覆盖；
 * - **严格三态**：pass / fail / not_run；not_run 不计通过，deferred 不计通过；
 *   缺失结果、真实模型缺失、负责人未确认或跨层检查未运行均保持 not_run，
 *   不把缺失输入默认为通过；人工 pending/rejected 不能由机器代签；
 * - **运行身份**：固定 runId、受测 commit、输入摘要与工具链；报告与证据引用
 *   必须绑定同一身份，身份漂移 fail-closed；运行目录一次性预留，旧运行目录
 *   不可被覆盖（fail-preserve-previous）；
 * - **两类 live 分开**：Todo 新项目 live（shiploop.todo.live-evidence）与存量
 *   项目 live（shiploop.brownfield.evidence-envelope）分别核对、互不替代；
 *   默认入口不调用真实模型，真实模型须负责人经独立 accept:p08:live 入口授权；
 * - **Nezha 边界**：Nezha 只作为开发编排工具；Harness 状态、测试数量或成功
 *   日志文字不得作为产品通过依据；本 Feature 不自动 npm 发布、不 push、
 *   不修改 Phase 状态，人工批准前不安排正式发布；
 * - **本 Task 边界**：本模块只验证配置、清单和 schema 的结构、唯一性及允许值，
 *   不执行 Git/SQLite/Host/进程命令；真实安装、跨层故障与两类真实项目事实由
 *   P08-4 后续 Task（身份校验、范围计划、证据导入、安装检查、入口与 Phase
 *   集成场景）交付。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除直接运行。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const P08_CHECKLIST_VERSION = 1;
export const P08_ACCEPT_CONFIG_VERSION = 1;
export const P08_ENTRY_SCHEMA_VERSION = 1;
export const P08_CHECKLIST_PATH = 'acceptance/p08.checklist.json';
export const P08_ACCEPT_CONFIG_PATH = 'acceptance/p08.config.json';
export const P08_ENTRY_PATH = 'acceptance/p08.entry.json';

/** 前序交付 Feature；P08-4 为本验收 Feature 本身，不进入前置清单。 */
export const P08_PREREQUISITE_FEATURES = ['P08-1', 'P08-2', 'P08-3'] as const;
export type P08PrerequisiteFeature = (typeof P08_PREREQUISITE_FEATURES)[number];
export const P08_ACCEPT_FEATURE = 'P08-4';
/** 验证层次（PRD §3.3 / AC-1）：代码交付、Task 局部、Feature 门禁、Phase 集成、Live、人工确认。 */
export const P08_LAYERS = ['code-delivery', 'task-local', 'feature-gate', 'phase-integration', 'live', 'manual'] as const;
export type P08Layer = (typeof P08_LAYERS)[number];
export const P08_EXECUTION_TYPES = ['offline', 'live', 'manual', 'postponed'] as const;
export type P08ExecutionType = (typeof P08_EXECUTION_TYPES)[number];
export const P08_EVIDENCE_CATEGORIES = [
  'command-exit', 'report', 'manifest', 'sha', 'artifact', 'install', 'host', 'sqlite', 'git', 'process',
  'deterministic-regression', 'todo-live', 'existing-live', 'usage', 'manual', 'harness-boundary', 'cleanup',
] as const;
export type P08EvidenceCategory = (typeof P08_EVIDENCE_CATEGORIES)[number];
export const P08_FR_IDS = ['FR-1', 'FR-2', 'FR-3'] as const;
export type P08FrId = (typeof P08_FR_IDS)[number];
/** 两类真实项目 live 证据：分开核对、互不替代（PRD FR-3）。 */
export const P08_LIVE_KINDS = ['todo-live', 'existing-live'] as const;
export type P08LiveKind = (typeof P08_LIVE_KINDS)[number];
export const P08_LIVE_EVIDENCE_KINDS = {
  'todo-live': 'shiploop.todo.live-evidence',
  'existing-live': 'shiploop.brownfield.evidence-envelope',
} as const;
export const P08_REPORT_STATUSES = ['pass', 'fail', 'not_run'] as const;
export type P08ReportStatus = (typeof P08_REPORT_STATUSES)[number];

export const P08_COUNT_RULE =
  '必需项全部 pass 才算通过；not_run 与人工 pending 不计入通过；deferred 项不参与通过计数；Todo live 与存量 live 分开核对、互不替代；覆盖按必需断言与可观察事实判定，不按 Harness 状态、测试数量或成功日志文字判断';

/** 工具链与运行资格：步骤串行，隔离测试文件至多两个 worker。 */
export const P08_TOOLCHAIN = {
  packageManager: 'npm@10.9.3', node: '22.19.0', npm: '10.9.3', lockfile: 'package-lock.json',
  platform: 'darwin', platformLabel: 'macOS', defaultConcurrency: 2,
} as const;
export const P08_FAKE_IDENTITY = {
  provider: 'fake-provider', model: 'fake-model', realModel: false, network: 'denied',
} as const;
export const P08_TEMP_RESOURCES = {
  git: 'temp', sqlite: 'temp', dataRoot: 'temp', home: 'temp', processes: 'owned-only', reusePrevious: false,
} as const;
export const P08_EXECUTION_POLICY = {
  offline: { runtime: 'fake-or-scripted', network: 'denied', llmCalls: false },
  live: { realModelRequiresOwnerAuthorization: true, separateEntry: 'npm run accept:p08:live', defaultEntryLlmCalls: false, fakeOrDeterministicNotAdmissible: true },
  manual: { ownerConfirmationRequired: true, machineMaySign: false },
  notRun: { countsAsPassed: false },
} as const;
export const P08_LIVE_POLICY = {
  requiredGate: true,
  separateKinds: ['todo-live', 'existing-live'],
  crossSubstitutionAllowed: false,
  missingBehavior: 'not_run',
  ownerUnconfirmedBehavior: 'not_run',
  realModelRequiresOwnerAuthorization: true,
  defaultEntryCallsRealModel: false,
  note: '两类真实项目 live 证据分别核对；真实模型缺失、负责人未确认或跨层检查未运行均保持 not_run，不折算通过',
} as const;
export const P08_RUN_IDENTITY_POLICY = {
  requiredFields: ['runId', 'testedCommit', 'inputsDigest', 'toolchain'],
  reportAndEvidenceBindSameIdentity: true,
  runDirectoryPolicy: 'create-once',
  existingRunDirectoryBehavior: 'fail-preserve-previous',
} as const;
export const P08_NEZHA_BOUNDARY = {
  role: 'development-orchestration-tool-only',
  productRuntimeDependency: false,
  harnessStateAsPassEvidence: false,
  testCountsAsPassEvidence: false,
  successLogTextAsPassEvidence: false,
  autoNpmPublish: false,
  autoPush: false,
  autoPhaseStatusChange: false,
  releaseRequiresOwnerApproval: true,
} as const;
export const P08_PUBLICATION_POLICY = {
  autoPublish: false,
  autoPush: false,
  modifiesPhaseStatus: false,
  npmPublishRequires: 'owner-approved-after-acceptance',
} as const;
export const P08_REPORT_SCOPE = {
  statuses: ['pass', 'fail', 'not_run'], includeEvidenceHash: true, includeManualChecklist: true,
  notRunCountsAsPassed: false, deferredCountsAsPassed: false,
} as const;
/** 工程检查（类型/边界/构建）复用既有入口；无参数 verify 的全仓语义不变。 */
export const P08_ENGINEERING_CHECKS = {
  typecheck: 'npm run typecheck',
  boundaries: 'npm run check:boundaries',
  build: 'npm run build',
  checksOnlyEntry: 'node scripts/verify.ts --checks-only',
  note: 'typecheck/build 复用 verify --checks-only；模块边界检查使用 check:boundaries',
} as const;
export const P08_VERIFY_SEMANTICS = {
  noArgCommand: ['npm', 'run', 'verify'],
  noArgSteps: ['typecheck', 'test', 'build'],
  modifiedByPhaseEntry: false,
  noArgRunClaimableByPhaseReport: false,
  reason: '无参数 npm run verify 仍执行全仓测试+类型+构建；P08 入口不修改该语义，也不得在报告中声称其已通过',
} as const;
export const P08_MODES = {
  default: {
    name: 'phase',
    phaseTrustedTests: true,
    priorPhaseDeterministicSuites: true,
    affectedRegressions: true,
    engineeringChecks: { typecheck: 'npm run typecheck', boundaries: 'npm run check:boundaries', build: 'npm run build' },
    installationChecks: true,
    liveEvidence: 'import-only',
    fullRepositoryTests: false,
    mayClaim: ['phase-scope-passed', 'engineering-checks-passed', 'installation-checks-passed'],
    mustNotClaim: ['no-arg-verify-passed', 'full-history-regression-passed', 'live-executed-by-default-entry'],
  },
  full: {
    name: 'full',
    phaseTrustedTests: true,
    priorPhaseDeterministicSuites: true,
    affectedRegressions: true,
    engineeringChecks: { typecheck: 'npm run typecheck', boundaries: 'npm run check:boundaries', build: 'npm run build' },
    installationChecks: true,
    liveEvidence: 'import-only',
    fullRepositoryTests: true,
    fullRegressionCommand: ['npm', 'test'],
    optIn: '--full-regression',
    mayClaim: ['phase-scope-passed', 'engineering-checks-passed', 'installation-checks-passed', 'full-history-regression-passed'],
    mustNotClaim: ['no-arg-verify-passed', 'live-executed-by-default-entry'],
  },
} as const;
export const P08_ENTRY_STEP_ORDER = [
  'p08-prerequisites', 'p08-source-identity', 'p08-deterministic-scope', 'p08-installation', 'p08-live-import', 'p08-report', 'p08-manual-gate',
] as const;
export const P08_ENTRY_EVIDENCE_REQUIRED_FIELDS = [
  'scenarioId', 'inputDigest', 'testedCommit', 'command', 'exitCode', 'status', 'evidenceRefs', 'usageSource', 'cleanup',
] as const;

/**
 * 前序 Feature 交付输入（按 P08-1～P08-3 实际交付核对，不凭空写死路径）：
 * - P08-1：交付报告 + 机器可读发布清单（本仓库内）；
 * - P08-2：live 入口文档 + Todo live 证据报告（由 accept:p08:live 在外部运行目录生成）；
 * - P08-3：存量演示报告模板与运行手册 + brownfield 证据封套（由演示执行生成）。
 */
export const P08_PREREQUISITE_INPUTS = {
  'P08-1': {
    reports: ['docs/acceptance/p08-1-delivery-report.md'],
    machineReadable: ['acceptance/p08-1.release-manifest.json'],
    liveEvidenceKind: null,
    producer: 'P08-1 本地交付：pack-local、制品检查、发布 CI 配置、用户指南与操作 Skills',
  },
  'P08-2': {
    reports: ['docs/p08-2-live-acceptance-entry.md'],
    machineReadable: [],
    liveEvidenceKind: 'shiploop.todo.live-evidence',
    producer: 'npm run accept:p08:live（scripts/acceptance/p08-todo-live-entry.ts）',
  },
  'P08-3': {
    reports: ['docs/acceptance/p08-3-demo-report-template.md', 'docs/acceptance/p08-3-existing-demo-runbook.md'],
    machineReadable: [],
    liveEvidenceKind: 'shiploop.brownfield.evidence-envelope',
    producer: '存量演示按运行手册执行并填写结果报告（packages/core/src/ports/brownfield-evidence.ts 封套）',
  },
} as const;
export const P08_PREREQUISITE_CONTRACT = {
  features: [...P08_PREREQUISITE_FEATURES],
  missingBehavior: 'blocked-not-run',
  placeholderAllowed: false,
  commitAncestryRequired: true,
  staleReportBehavior: 'not_run',
  deliveryInputs: P08_PREREQUISITE_INPUTS,
} as const;

export type P08ItemGroup = 'fr' | 'scenario' | 'manual' | 'deferred';
export type P08FrozenItem = {
  readonly id: string;
  readonly group: P08ItemGroup;
  readonly title: string;
  readonly layer: P08Layer;
  readonly execution: P08ExecutionType;
  readonly features: readonly string[];
  readonly fr: readonly string[];
  readonly acceptanceRefs: readonly string[];
  readonly assertions: readonly string[];
  readonly evidence: readonly P08EvidenceCategory[];
};

const FR_ITEMS: readonly P08FrozenItem[] = [
  {
    id: 'P08-FR1-PHASE-CLOSURE-RERUN', group: 'fr', title: 'FR-1 阶段闭环复跑与两类真实项目证据核对', layer: 'phase-integration', execution: 'offline',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-1', 'FR-3'], acceptanceRefs: ['FR-1', 'AC-1', 'AC-3', 'P08-4'],
    assertions: [
      '从干净安装目录启动打包后的 CLI 复核一期确定性闭环（Todo 新项目到交付），并核对 P08-1～P08-3 生成的新项目及存量真实验收证据；实际模型流程只使用独立 live 入口',
      'SQLite/Git/进程使用真实临时资源；夹具准备或必需检查未运行记 not_run 并使阶段未通过；重复运行使用独立 run-id 与临时资源，不依赖上一次残留',
      '清理不触及用户仓库；前序报告与本次报告绑定同一运行身份',
    ],
    evidence: ['command-exit', 'report', 'manifest', 'sha', 'artifact', 'install', 'host', 'sqlite', 'git', 'process', 'usage', 'cleanup'],
  },
  {
    id: 'P08-FR2-NEGATIVE-EVIDENCE', group: 'fr', title: 'FR-2 负例与证据完整性', layer: 'phase-integration', execution: 'offline',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'AC-3', 'AC-4', 'AC-5'],
    assertions: [
      '每个失败/冲突/恢复用例绑定场景 ID、输入摘要、受测 commit、实际命令、退出码、状态与必需事实类别；正常完成文本或测试数量不构成通过依据',
      '不能靠手工改 SQLite、忽略失败或跳过必需检查通过；敏感凭据与开发机绝对路径不进入报告',
      'not_run 与已知缺口如实展示；not_run 不折算通过',
    ],
    evidence: ['command-exit', 'report', 'manifest', 'sha', 'usage', 'cleanup'],
  },
  {
    id: 'P08-FR3-PERIOD-EVIDENCE-AGGREGATE', group: 'fr', title: 'FR-3 一期证据汇总边界', layer: 'feature-gate', execution: 'offline',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-3'], acceptanceRefs: ['FR-3', 'AC-1', 'AC-3', 'AC-5'],
    assertions: [
      'P01～P07 阶段报告与独立安装检查作为聚合输入；Todo live 与存量 live 分别核对，不用其中一类替代另一类',
      '陈旧代码基线报告不可当本次通过；live 缺失列未完成；后置 UI/Chat/云等不混入一期验收',
      'accept:p08 聚合前序确定性套件和安装检查，不递归调用自身',
    ],
    evidence: ['report', 'manifest', 'sha', 'todo-live', 'existing-live', 'usage', 'harness-boundary'],
  },
];

const SCENARIO_ITEMS: readonly P08FrozenItem[] = [
  {
    id: 'P08-PREREQ-DELIVERY-REPORTS', group: 'scenario', title: 'P08-1～P08-3 交付报告前置输入', layer: 'code-delivery', execution: 'offline',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-3'], acceptanceRefs: ['FR-3', 'AC-3', 'P08-1', 'P08-2', 'P08-3'],
    assertions: [
      'P08-1 交付报告与发布清单、P08-2 Todo live 入口交付、P08-3 存量演示契约与运行手册作为前置输入逐项登记',
      '交付缺失、报告缺失、commit 非法或非受测 HEAD 祖先时输出 blocked/not_run，不以占位实现或补库放行',
    ],
    evidence: ['report', 'manifest', 'sha'],
  },
  {
    id: 'P08-INSTALL-CLEAN-DIRECTORY', group: 'scenario', title: '干净安装与本地 pack 产物检查', layer: 'phase-integration', execution: 'offline',
    features: ['P08-1'], fr: ['FR-1', 'FR-3'], acceptanceRefs: ['FR-1', 'FR-3', 'AC-2', 'P08-1'],
    assertions: [
      '在无 Nezha Harness 的独立目录安装本地 pack 产物，启动打包 CLI 核对 Core/Host 运行入口、依赖闭包与版本协议',
      'Nezha 运行时隔离核对：安装目录不依赖 Harness 路径或其运行状态',
    ],
    evidence: ['command-exit', 'install', 'artifact', 'manifest', 'host', 'process', 'sha', 'cleanup'],
  },
  {
    id: 'P08-TODO-NEW-PROJECT-CLOSURE', group: 'scenario', title: 'Todo 新项目确定性闭环', layer: 'phase-integration', execution: 'offline',
    features: ['P08-1', 'P08-2'], fr: ['FR-1'], acceptanceRefs: ['FR-1', 'AC-1', 'P08-2'],
    assertions: [
      '打包 CLI 完成 Todo 需求到交付的确定性闭环（规划批准、有限预算、执行、验证、Git 提交与报告），全程 Fake/脚本化 Runtime，不调用真实模型',
      '需求行为目录（新增/列表/完成/删除/持久化/失败分支）逐项复核；失败分支保全数据并保留现场',
    ],
    evidence: ['command-exit', 'sqlite', 'git', 'host', 'process', 'artifact', 'manifest', 'report', 'usage', 'cleanup'],
  },
  {
    id: 'P08-EXISTING-INCREMENTAL-CLOSURE', group: 'scenario', title: '存量项目确定性增量变更', layer: 'phase-integration', execution: 'offline',
    features: ['P08-1', 'P08-2', 'P08-3'], fr: ['FR-1'], acceptanceRefs: ['FR-1', 'AC-1', 'P08-3'],
    assertions: [
      '非 Nezha 创建的存量仓库接入后完成一次确定性增量变更：基线快照、初始化保护（HEAD/脏状态不变、禁止自动提交）、增量执行与验证、已知失败不豁免',
      '归档/重开与仓库移动确认按生命周期门控执行；跨层组合事实留给真实资源场景，缺失记 not_run',
    ],
    evidence: ['command-exit', 'sqlite', 'git', 'host', 'process', 'artifact', 'manifest', 'report', 'cleanup'],
  },
  {
    id: 'P08-DETERMINISTIC-PHASE-REGRESSION', group: 'scenario', title: '适用阶段确定性回归与工程检查', layer: 'phase-integration', execution: 'offline',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-1', 'FR-3'], acceptanceRefs: ['FR-1', 'FR-3', 'AC-1', 'AC-4'],
    assertions: [
      '复跑适用的 P01～P07 阶段确定性验收与工程检查（类型/边界/构建）；无参数 npm run verify 的全仓语义不被修改',
      '全仓历史回归仅经显式 --full-regression 开启；未运行记 not_run，不计入通过',
    ],
    evidence: ['command-exit', 'report', 'manifest', 'deterministic-regression', 'usage'],
  },
  {
    id: 'P08-LIVE-TODO-EVIDENCE', group: 'scenario', title: 'Todo 新项目真实 live 证据', layer: 'live', execution: 'live',
    features: ['P08-2'], fr: ['FR-1', 'FR-3'], acceptanceRefs: ['FR-3', 'AC-1', 'P08-2'],
    assertions: [
      'Todo 新项目真实 Pi live 证据（shiploop.todo.live-acceptance / shiploop.todo.live-evidence）单独导入核对：provider/model、人工批准、预算、commit/tree 与运行身份绑定',
      '真实模型缺失或证据缺失保持 not_run；不以 FakeRuntime 或 Todo 确定性闭环替代',
    ],
    evidence: ['todo-live', 'report', 'manifest', 'sha', 'usage', 'manual'],
  },
  {
    id: 'P08-LIVE-EXISTING-EVIDENCE', group: 'scenario', title: '存量项目真实 live 证据', layer: 'live', execution: 'live',
    features: ['P08-3'], fr: ['FR-1', 'FR-3'], acceptanceRefs: ['FR-3', 'AC-1', 'P08-3'],
    assertions: [
      '存量项目真实变更 live 证据（shiploop.brownfield.evidence-envelope 及演示报告）单独导入核对，与 Todo live 分开判定',
      '一类证据缺失不因另一类存在而通过；负责人未确认保持 not_run',
    ],
    evidence: ['existing-live', 'report', 'manifest', 'sha', 'usage', 'manual'],
  },
  {
    id: 'P08-TASK-LOCAL-VERIFICATION', group: 'scenario', title: 'Task 局部验证边界', layer: 'task-local', execution: 'offline',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'AC-4', 'AC-5'],
    assertions: [
      'P08 各 Task 局部验证记录实际命令、退出码与证据路径；Task 局部通过不宣称 Feature 门禁或 Phase 验收通过',
      'Task 索引登记完整且与实际文件一致；不靠改名/漏选用例获取通过',
    ],
    evidence: ['command-exit', 'report', 'manifest', 'usage'],
  },
  {
    id: 'P08-FEATURE-GATE-UNION', group: 'scenario', title: 'Feature 门禁输入边界', layer: 'feature-gate', execution: 'offline',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-2', 'FR-3'], acceptanceRefs: ['FR-2', 'FR-3', 'AC-1'],
    assertions: [
      'P08-1～P08-4 的 Feature 门禁按去重 Task 索引执行；门禁结果作为阶段输入登记',
      'Feature 门禁通过不等于 Phase 集成通过；跨层事实由 Phase 集成场景提供',
    ],
    evidence: ['command-exit', 'report', 'manifest', 'deterministic-regression'],
  },
  {
    id: 'P08-RUN-IDENTITY-INTEGRITY', group: 'scenario', title: '运行身份与运行目录完整性', layer: 'feature-gate', execution: 'offline',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-2'], acceptanceRefs: ['FR-2', 'AC-2', 'AC-5'],
    assertions: [
      'P08 运行身份固定 runId、受测 commit、输入摘要与工具链；报告与证据引用必须绑定同一身份',
      '旧运行目录不可被覆盖；身份或结构不匹配 fail-closed',
    ],
    evidence: ['report', 'manifest', 'sha', 'cleanup'],
  },
  {
    id: 'P08-HARNESS-BOUNDARY', group: 'scenario', title: 'Nezha 开发工具边界', layer: 'code-delivery', execution: 'offline',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-3'], acceptanceRefs: ['FR-3', 'AC-2', 'AC-5'],
    assertions: [
      'Nezha 只作为开发编排工具：Harness 状态、测试数量或成功日志文字不得作为产品通过依据',
      '本 Feature 不自动 npm 发布、不 push、不修改 Phase 状态；人工批准前不安排正式发布',
    ],
    evidence: ['harness-boundary', 'report', 'manifest'],
  },
];

const MANUAL_ITEMS: readonly P08FrozenItem[] = [
  {
    id: 'P08-MANUAL-OWNER-GATE', group: 'manual', title: 'P08 负责人 macOS 操作与一期放行', layer: 'manual', execution: 'manual',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-2', 'FR-3'], acceptanceRefs: ['FR-2', 'FR-3', 'AC-4', 'AC-5'],
    assertions: [
      '负责人按 macOS 清单核对安装、两类真实项目、确定性回归、live 证据与已知缺口，记录完整 SHA、命令、退出码并明确确认时间与结论',
      'pending/rejected 或缺签署时阶段不能通过；机器成功不能代签',
    ],
    evidence: ['manual', 'report', 'manifest', 'sha', 'usage', 'cleanup'],
  },
];

const DEFERRED_ITEMS: readonly P08FrozenItem[] = [
  {
    id: 'P08-POST-FULL-HISTORY-REGRESSION', group: 'deferred', title: '后置：全仓历史回归', layer: 'phase-integration', execution: 'postponed',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-3'], acceptanceRefs: ['FR-3', 'FULL-REGRESSION'],
    assertions: [
      '全仓历史回归只能由显式 --full-regression 选项或发布验收发起，不属于默认 P08 阶段门禁',
      '未运行全仓回归报告为 not_run，不计入阶段通过；无参数 npm run verify 未执行时同样不得声称通过',
    ],
    evidence: ['command-exit', 'report', 'manifest'],
  },
  {
    id: 'P08-POST-RELEASE-PUBLISH', group: 'deferred', title: '后置：正式发布与后置能力', layer: 'phase-integration', execution: 'postponed',
    features: [...P08_PREREQUISITE_FEATURES], fr: ['FR-3'], acceptanceRefs: ['FR-3', 'POST-RELEASE'],
    assertions: [
      'npm 公开发布、自动 push/PR、Electron、Chat、其他 Runtime 与跨平台正式认证不混入一期验收',
      '人工批准一期验收后才安排正式发布；本 Feature 不自动发布或推送',
    ],
    evidence: ['report', 'manifest', 'manual'],
  },
];

export const P08_FROZEN_ITEMS: readonly P08FrozenItem[] = [
  ...FR_ITEMS, ...SCENARIO_ITEMS, ...MANUAL_ITEMS, ...DEFERRED_ITEMS,
];
export const P08_REQUIRED_CHECK_IDS = P08_FROZEN_ITEMS.filter(item => item.group !== 'deferred').map(item => item.id);
export const P08_DEFERRED_IDS = P08_FROZEN_ITEMS.filter(item => item.group === 'deferred').map(item => item.id);
const ITEM_BY_ID = new Map(P08_FROZEN_ITEMS.map(item => [item.id, item]));

const CHECKLIST_KEYS = ['checklistVersion', 'phase', 'layers', 'executionTypes', 'evidenceCategories', 'countRule', 'items'] as const;
const ITEM_KEYS = ['id', 'group', 'title', 'layer', 'execution', 'features', 'fr', 'acceptanceRefs', 'assertions', 'evidence'] as const;
const CONFIG_KEYS = ['configVersion', 'checklist', 'reportRoot', 'requiredChecks', 'toolchain', 'timeouts', 'maxCommandOutputBytes', 'fakeIdentity', 'tempResources', 'executionPolicy', 'livePolicy', 'runIdentity', 'prerequisites', 'reportScope', 'engineeringChecks', 'verifySemantics', 'modes', 'fullRegression', 'nezhaBoundary', 'publicationPolicy', 'usageSources', 'plan'] as const;
const ENTRY_KEYS = ['schemaVersion', 'phase', 'stepOrder', 'trustedIndexRoot', 'requiredFeatures', 'prerequisites', 'defaultExecution', 'modes', 'verify', 'explicitOptions', 'separateLiveEntry', 'evidence', 'runIdentity', 'nezhaBoundary', 'toolchain', 'budget'] as const;
const CREDENTIAL_KEY = /(?:authorization|auth|token|password|passwd|secret|credential|cookie|api[_-]?key)/i;
const BUSINESS_KEY = /^(?:schemaVersions|migrations?|settings|database|productConfig|businessConfig)$/i;
const ID_PATTERN = /^P08-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const REF_PATTERN = /^(?:FR-[1-3]|P08-[1-4]|AC-[1-5]|FULL-REGRESSION|POST-RELEASE)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type P08AcceptErrorKind = 'invalid_config' | 'identity_mismatch';

export class P08AcceptError extends Error {
  readonly kind: P08AcceptErrorKind;
  readonly detail?: string;
  constructor(kind: P08AcceptErrorKind, message: string, detail?: string) { super(message); this.name = 'P08AcceptError'; this.kind = kind; this.detail = detail; }
}
function fail(message: string, detail?: string): never { throw new P08AcceptError('invalid_config', message, detail); }
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

/** 键序无关的稳定序列化，用于冻结对象比对与摘要。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function same(value: unknown, expected: unknown, label: string): void { if (canonicalJson(value) !== canonicalJson(expected)) fail(`${label} 与冻结基线不一致`); }

function validateItem(rawValue: unknown, index: number): void {
  const raw = object(rawValue, `items[${index}]`);
  keys(raw, ITEM_KEYS, `items[${index}]`);
  for (const key of ITEM_KEYS) if (!(key in raw)) fail(`items[${index}] 缺少字段：${key}`);
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) fail(`items[${index}].id 非法`);
  const expected = ITEM_BY_ID.get(raw.id);
  if (!expected) fail(`items[${index}] 含未知检查：${raw.id}`);
  if (raw.group !== expected.group || raw.title !== expected.title || raw.layer !== expected.layer || raw.execution !== expected.execution) fail(`检查 ${raw.id} 的身份、层次或执行类别被改写`);
  exactStrings(raw.features, expected.features, `${raw.id}.features`);
  const fr = exactStrings(raw.fr, expected.fr, `${raw.id}.fr`);
  if (fr.some(value => !P08_FR_IDS.includes(value as P08FrId))) fail(`${raw.id}.fr 含未知 FR`);
  const refs = exactStrings(raw.acceptanceRefs, expected.acceptanceRefs, `${raw.id}.acceptanceRefs`);
  if (refs.some(value => !REF_PATTERN.test(value))) fail(`${raw.id}.acceptanceRefs 含未知引用`);
  exactStrings(raw.assertions, expected.assertions, `${raw.id}.assertions`);
  const evidence = exactStrings(raw.evidence, expected.evidence, `${raw.id}.evidence`);
  if (evidence.some(value => !P08_EVIDENCE_CATEGORIES.includes(value as P08EvidenceCategory))) fail(`${raw.id}.evidence 含未知类别`);
}

export type P08Checklist = {
  readonly checklistVersion: 1; readonly phase: 'P08'; readonly layers: readonly P08Layer[]; readonly executionTypes: readonly P08ExecutionType[];
  readonly evidenceCategories: readonly P08EvidenceCategory[]; readonly countRule: string; readonly items: readonly P08FrozenItem[];
};

export function validateP08Checklist(value: unknown): P08Checklist {
  const raw = object(value, 'checklist');
  keys(raw, CHECKLIST_KEYS, 'checklist');
  if (raw.checklistVersion !== P08_CHECKLIST_VERSION || raw.phase !== 'P08') fail('清单版本或阶段不匹配');
  exactStrings(raw.layers, P08_LAYERS, 'layers');
  exactStrings(raw.executionTypes, P08_EXECUTION_TYPES, 'executionTypes');
  exactStrings(raw.evidenceCategories, P08_EVIDENCE_CATEGORIES, 'evidenceCategories');
  if (raw.countRule !== P08_COUNT_RULE) fail('countRule 被改写');
  if (!Array.isArray(raw.items) || raw.items.length !== P08_FROZEN_ITEMS.length) fail('items 数量与冻结清单不一致');
  const seen = new Set<string>();
  (raw.items as unknown[]).forEach((item, index) => {
    validateItem(item, index);
    const id = (item as { id: string }).id;
    if (seen.has(id)) fail(`检查 ID 重复：${id}`);
    seen.add(id);
    if (id !== P08_FROZEN_ITEMS[index].id) fail(`检查顺序被改写：${id}`);
  });
  // 需求覆盖缺项拒绝：每个 FR、前序 Feature、验证层次与两类 live 都必须被必需检查覆盖，
  // 不以测试数量或清单长度证明需求覆盖。
  const required = P08_FROZEN_ITEMS.filter(item => item.group !== 'deferred');
  for (const fr of P08_FR_IDS) if (!required.some(item => item.fr.includes(fr))) fail(`必需检查缺少 FR 覆盖：${fr}`);
  for (const feature of P08_PREREQUISITE_FEATURES) if (!required.some(item => item.features.includes(feature))) fail(`必需检查缺少前序 Feature 覆盖：${feature}`);
  for (const layer of P08_LAYERS) if (!required.some(item => item.layer === layer)) fail(`必需检查缺少验证层次覆盖：${layer}`);
  for (const kind of P08_LIVE_KINDS) if (!required.some(item => item.evidence.includes(kind))) fail(`必需检查缺少 live 证据类别覆盖：${kind}`);
  return { checklistVersion: P08_CHECKLIST_VERSION, phase: 'P08', layers: [...P08_LAYERS], executionTypes: [...P08_EXECUTION_TYPES], evidenceCategories: [...P08_EVIDENCE_CATEGORIES], countRule: P08_COUNT_RULE, items: P08_FROZEN_ITEMS };
}

export type P08FullRegression = { readonly defaultEnabled: false; readonly optInFlag: '--full-regression'; readonly command: readonly string[]; readonly reason: string };
export type P08AcceptanceConfig = {
  readonly configVersion: 1; readonly checklist: string; readonly reportRoot: string; readonly requiredChecks: readonly string[];
  readonly toolchain: typeof P08_TOOLCHAIN; readonly timeouts: { readonly stepMs: number; readonly overallMs: number };
  readonly maxCommandOutputBytes: number; readonly fakeIdentity: typeof P08_FAKE_IDENTITY; readonly tempResources: typeof P08_TEMP_RESOURCES;
  readonly executionPolicy: typeof P08_EXECUTION_POLICY; readonly livePolicy: typeof P08_LIVE_POLICY; readonly runIdentity: typeof P08_RUN_IDENTITY_POLICY;
  readonly prerequisites: typeof P08_PREREQUISITE_CONTRACT; readonly reportScope: typeof P08_REPORT_SCOPE;
  readonly engineeringChecks: typeof P08_ENGINEERING_CHECKS; readonly verifySemantics: typeof P08_VERIFY_SEMANTICS; readonly modes: typeof P08_MODES;
  readonly fullRegression: P08FullRegression; readonly nezhaBoundary: typeof P08_NEZHA_BOUNDARY; readonly publicationPolicy: typeof P08_PUBLICATION_POLICY;
  readonly usageSources: readonly string[]; readonly plan: { readonly phaseId: string; readonly stepId: string; readonly title: string; readonly scope: string; readonly version: string; readonly contractDoc: string };
};

export function validateP08AcceptanceConfig(value: unknown): P08AcceptanceConfig {
  const raw = object(value, 'config'); keys(raw, CONFIG_KEYS, 'config');
  if (raw.configVersion !== P08_ACCEPT_CONFIG_VERSION) fail('configVersion 不匹配');
  const checklist = relativePath(raw.checklist, 'checklist');
  const reportRoot = relativePath(raw.reportRoot, 'reportRoot');
  exactStrings(raw.requiredChecks, P08_REQUIRED_CHECK_IDS, 'requiredChecks');
  same(raw.toolchain, P08_TOOLCHAIN, 'toolchain'); same(raw.fakeIdentity, P08_FAKE_IDENTITY, 'fakeIdentity'); same(raw.tempResources, P08_TEMP_RESOURCES, 'tempResources');
  same(raw.executionPolicy, P08_EXECUTION_POLICY, 'executionPolicy'); same(raw.livePolicy, P08_LIVE_POLICY, 'livePolicy'); same(raw.runIdentity, P08_RUN_IDENTITY_POLICY, 'runIdentity');
  same(raw.reportScope, P08_REPORT_SCOPE, 'reportScope'); same(raw.nezhaBoundary, P08_NEZHA_BOUNDARY, 'nezhaBoundary'); same(raw.publicationPolicy, P08_PUBLICATION_POLICY, 'publicationPolicy');
  same(raw.engineeringChecks, P08_ENGINEERING_CHECKS, 'engineeringChecks'); same(raw.verifySemantics, P08_VERIFY_SEMANTICS, 'verifySemantics'); same(raw.modes, P08_MODES, 'modes');
  const prerequisites = object(raw.prerequisites, 'prerequisites'); keys(prerequisites, ['features', 'missingBehavior', 'placeholderAllowed', 'commitAncestryRequired', 'staleReportBehavior', 'deliveryInputs'], 'prerequisites');
  same(prerequisites, P08_PREREQUISITE_CONTRACT, 'prerequisites');
  const timeouts = object(raw.timeouts, 'timeouts'); keys(timeouts, ['stepMs', 'overallMs'], 'timeouts');
  const stepMs = bounded(timeouts.stepMs, P08_ACCEPT_MIN_TIMEOUT_MS, P08_ACCEPT_MAX_TIMEOUT_MS, 'timeouts.stepMs');
  const overallMs = bounded(timeouts.overallMs, P08_ACCEPT_MIN_TIMEOUT_MS, P08_ACCEPT_MAX_OVERALL_MS, 'timeouts.overallMs');
  if (overallMs < stepMs) fail('overallMs 不能小于 stepMs');
  bounded(raw.maxCommandOutputBytes, P08_ACCEPT_MIN_OUTPUT_BYTES, P08_ACCEPT_MAX_OUTPUT_BYTES, 'maxCommandOutputBytes');
  const fullRegression = object(raw.fullRegression, 'fullRegression'); keys(fullRegression, ['defaultEnabled', 'optInFlag', 'command', 'reason'], 'fullRegression');
  if (fullRegression.defaultEnabled !== false || fullRegression.optInFlag !== '--full-regression') fail('全仓历史回归必须关闭默认开关并使用显式 --full-regression');
  exactStrings(fullRegression.command, ['npm', 'test'], 'fullRegression.command');
  if (typeof fullRegression.reason !== 'string' || fullRegression.reason.length === 0) fail('fullRegression.reason 必须说明显式开关原因');
  const usageSources = strings(raw.usageSources, 'usageSources');
  if (new Set(usageSources).size !== usageSources.length || !usageSources.includes('runtime-usage') || !usageSources.includes('command-output') || !usageSources.includes('manual-record') || !usageSources.includes('not_run')) fail('usageSources 必须包含稳定的用量来源分类');
  const plan = object(raw.plan, 'plan'); keys(plan, ['phaseId', 'stepId', 'title', 'scope', 'version', 'contractDoc'], 'plan');
  for (const key of ['phaseId', 'stepId', 'title', 'scope', 'version'] as const) if (typeof plan[key] !== 'string' || (plan[key] as string).length === 0) fail(`plan.${key} 必须是非空字符串`);
  const contractDoc = relativePath(plan.contractDoc, 'plan.contractDoc');
  return { configVersion: P08_ACCEPT_CONFIG_VERSION, checklist, reportRoot, requiredChecks: [...P08_REQUIRED_CHECK_IDS], toolchain: P08_TOOLCHAIN, timeouts: { stepMs, overallMs }, maxCommandOutputBytes: raw.maxCommandOutputBytes as number, fakeIdentity: P08_FAKE_IDENTITY, tempResources: P08_TEMP_RESOURCES, executionPolicy: P08_EXECUTION_POLICY, livePolicy: P08_LIVE_POLICY, runIdentity: P08_RUN_IDENTITY_POLICY, prerequisites: P08_PREREQUISITE_CONTRACT, reportScope: P08_REPORT_SCOPE, engineeringChecks: P08_ENGINEERING_CHECKS, verifySemantics: P08_VERIFY_SEMANTICS, modes: P08_MODES, fullRegression: { defaultEnabled: false, optInFlag: '--full-regression', command: ['npm', 'test'], reason: fullRegression.reason as string }, nezhaBoundary: P08_NEZHA_BOUNDARY, publicationPolicy: P08_PUBLICATION_POLICY, usageSources, plan: { phaseId: plan.phaseId as string, stepId: plan.stepId as string, title: plan.title as string, scope: plan.scope as string, version: plan.version as string, contractDoc } };
}

export type P08EntryContract = {
  readonly schemaVersion: 1;
  readonly phase: 'P08';
  readonly stepOrder: readonly string[];
  readonly trustedIndexRoot: string;
  readonly requiredFeatures: readonly string[];
  readonly prerequisites: typeof P08_PREREQUISITE_CONTRACT;
  readonly defaultExecution: { readonly mode: 'phase'; readonly network: 'denied'; readonly llmCalls: false; readonly fullRegression: false; readonly verifyChecksOnly: true; readonly liveEvidence: 'import-only' };
  readonly modes: typeof P08_MODES;
  readonly verify: typeof P08_VERIFY_SEMANTICS;
  readonly explicitOptions: { readonly fullRegression: '--full-regression'; readonly manualRecord: '--manual-record' };
  readonly separateLiveEntry: { readonly command: 'npm run accept:p08:live'; readonly realModel: true; readonly ownerApprovalRequired: true; readonly invokedByDefaultEntry: false };
  readonly evidence: { readonly requiredFields: readonly string[]; readonly statuses: readonly string[]; readonly notRunCountsAsPassed: false };
  readonly runIdentity: typeof P08_RUN_IDENTITY_POLICY;
  readonly nezhaBoundary: typeof P08_NEZHA_BOUNDARY;
  readonly toolchain: { readonly node: string; readonly npm: string; readonly platform: string; readonly defaultConcurrency: number };
  readonly budget: { readonly stepMs: number; readonly overallMs: number; readonly bounded: true };
};

export function validateP08EntryContract(value: unknown): P08EntryContract {
  const raw = object(value, 'entry'); keys(raw, ENTRY_KEYS, 'entry');
  if (raw.schemaVersion !== P08_ENTRY_SCHEMA_VERSION || raw.phase !== 'P08') fail('入口契约版本或阶段不匹配');
  exactStrings(raw.stepOrder, P08_ENTRY_STEP_ORDER, 'stepOrder');
  const trustedIndexRoot = relativePath(raw.trustedIndexRoot, 'trustedIndexRoot');
  exactStrings(raw.requiredFeatures, P08_PREREQUISITE_FEATURES, 'requiredFeatures');
  const prerequisites = object(raw.prerequisites, 'prerequisites');
  same(prerequisites, P08_PREREQUISITE_CONTRACT, 'prerequisites');
  const defaultExecution = object(raw.defaultExecution, 'defaultExecution'); keys(defaultExecution, ['mode', 'network', 'llmCalls', 'fullRegression', 'verifyChecksOnly', 'liveEvidence'], 'defaultExecution');
  same(defaultExecution, { mode: 'phase', network: 'denied', llmCalls: false, fullRegression: false, verifyChecksOnly: true, liveEvidence: 'import-only' }, 'defaultExecution');
  const modes = object(raw.modes, 'modes'); keys(modes, ['default', 'full'], 'modes');
  same(modes, P08_MODES, 'modes');
  const verify = object(raw.verify, 'verify');
  same(verify, P08_VERIFY_SEMANTICS, 'verify');
  const explicitOptions = object(raw.explicitOptions, 'explicitOptions'); keys(explicitOptions, ['fullRegression', 'manualRecord'], 'explicitOptions');
  same(explicitOptions, { fullRegression: '--full-regression', manualRecord: '--manual-record' }, 'explicitOptions');
  const separateLiveEntry = object(raw.separateLiveEntry, 'separateLiveEntry'); keys(separateLiveEntry, ['command', 'realModel', 'ownerApprovalRequired', 'invokedByDefaultEntry'], 'separateLiveEntry');
  same(separateLiveEntry, { command: 'npm run accept:p08:live', realModel: true, ownerApprovalRequired: true, invokedByDefaultEntry: false }, 'separateLiveEntry');
  const evidence = object(raw.evidence, 'evidence'); keys(evidence, ['requiredFields', 'statuses', 'notRunCountsAsPassed'], 'evidence');
  exactStrings(evidence.requiredFields, P08_ENTRY_EVIDENCE_REQUIRED_FIELDS, 'evidence.requiredFields');
  exactStrings(evidence.statuses, P08_REPORT_STATUSES, 'evidence.statuses');
  if (evidence.notRunCountsAsPassed !== false) fail('not_run 不得计为通过');
  const runIdentity = object(raw.runIdentity, 'runIdentity');
  same(runIdentity, P08_RUN_IDENTITY_POLICY, 'runIdentity');
  const nezhaBoundary = object(raw.nezhaBoundary, 'nezhaBoundary');
  same(nezhaBoundary, P08_NEZHA_BOUNDARY, 'nezhaBoundary');
  const toolchain = object(raw.toolchain, 'toolchain'); keys(toolchain, ['node', 'npm', 'platform', 'defaultConcurrency'], 'toolchain');
  if (toolchain.node !== P08_TOOLCHAIN.node || toolchain.npm !== P08_TOOLCHAIN.npm || toolchain.platform !== P08_TOOLCHAIN.platform || toolchain.defaultConcurrency !== P08_TOOLCHAIN.defaultConcurrency) fail('入口工具链必须与冻结工具链一致');
  const budget = object(raw.budget, 'budget'); keys(budget, ['stepMs', 'overallMs', 'bounded'], 'budget');
  const stepMs = bounded(budget.stepMs, P08_ACCEPT_MIN_TIMEOUT_MS, P08_ACCEPT_MAX_TIMEOUT_MS, 'budget.stepMs');
  const overallMs = bounded(budget.overallMs, P08_ACCEPT_MIN_TIMEOUT_MS, P08_ACCEPT_MAX_OVERALL_MS, 'budget.overallMs');
  if (overallMs < stepMs) fail('budget.overallMs 不能小于 budget.stepMs');
  if (budget.bounded !== true) fail('执行预算必须为有限值');
  return {
    schemaVersion: P08_ENTRY_SCHEMA_VERSION, phase: 'P08', stepOrder: [...P08_ENTRY_STEP_ORDER], trustedIndexRoot,
    requiredFeatures: [...P08_PREREQUISITE_FEATURES], prerequisites: P08_PREREQUISITE_CONTRACT,
    defaultExecution: { mode: 'phase', network: 'denied', llmCalls: false, fullRegression: false, verifyChecksOnly: true, liveEvidence: 'import-only' },
    modes: P08_MODES, verify: P08_VERIFY_SEMANTICS, explicitOptions: { fullRegression: '--full-regression', manualRecord: '--manual-record' },
    separateLiveEntry: { command: 'npm run accept:p08:live', realModel: true, ownerApprovalRequired: true, invokedByDefaultEntry: false },
    evidence: { requiredFields: [...P08_ENTRY_EVIDENCE_REQUIRED_FIELDS], statuses: [...P08_REPORT_STATUSES], notRunCountsAsPassed: false },
    runIdentity: P08_RUN_IDENTITY_POLICY, nezhaBoundary: P08_NEZHA_BOUNDARY,
    toolchain: { node: P08_TOOLCHAIN.node, npm: P08_TOOLCHAIN.npm, platform: P08_TOOLCHAIN.platform, defaultConcurrency: P08_TOOLCHAIN.defaultConcurrency },
    budget: { stepMs, overallMs, bounded: true },
  };
}

function parseJsonFile(path: string, label: string): unknown {
  if (!existsSync(path)) fail(`${label}不存在：${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { fail(`${label}不是有效 JSON：${String(error)}`); }
}
export function loadP08Checklist(path = P08_CHECKLIST_PATH): P08Checklist { return validateP08Checklist(parseJsonFile(path, '清单')); }
export function loadP08AcceptanceConfig(path: string): P08AcceptanceConfig { return validateP08AcceptanceConfig(parseJsonFile(path, '配置')); }
export function loadP08EntryContract(path = P08_ENTRY_PATH): P08EntryContract { return validateP08EntryContract(parseJsonFile(path, '入口契约')); }

export function summarizeP08Checklist(checklist: P08Checklist): { required: number; deferred: number; byExecution: Record<P08ExecutionType, number>; byFeature: Record<string, number>; layerCoverage: Record<P08Layer, number>; frCoverage: Record<P08FrId, number> } {
  const byExecution = Object.fromEntries(P08_EXECUTION_TYPES.map(type => [type, checklist.items.filter(item => item.execution === type).length])) as Record<P08ExecutionType, number>;
  const byFeature = Object.fromEntries(P08_PREREQUISITE_FEATURES.map(feature => [feature, checklist.items.filter(item => item.features.includes(feature)).length]));
  const required = checklist.items.filter(item => item.group !== 'deferred');
  const layerCoverage = Object.fromEntries(P08_LAYERS.map(layer => [layer, required.filter(item => item.layer === layer).length])) as Record<P08Layer, number>;
  const frCoverage = Object.fromEntries(P08_FR_IDS.map(fr => [fr, required.filter(item => item.fr.includes(fr)).length])) as Record<P08FrId, number>;
  return { required: required.length, deferred: checklist.items.filter(item => item.group === 'deferred').length, byExecution, byFeature, layerCoverage, frCoverage };
}

/** 清单内容摘要：内容或结构变化即变化，报告以此追溯清单版本。 */
export function digestP08Checklist(checklist: P08Checklist): string {
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
export function digestP08ExecutionMode(mode: 'default' | 'full'): string {
  const material = { phase: 'P08', mode, definition: P08_MODES[mode], verifySemantics: P08_VERIFY_SEMANTICS };
  return createHash('sha256').update(canonicalJson(material)).digest('hex');
}

/** 有限预算校验：非法预算（0、负数、非整数、越界、总体小于单步）一律拒绝。 */
export function validateP08Budget(timeouts: { stepMs: unknown; overallMs: unknown }): { stepMs: number; overallMs: number } {
  const stepMs = bounded(timeouts.stepMs, P08_ACCEPT_MIN_TIMEOUT_MS, P08_ACCEPT_MAX_TIMEOUT_MS, 'stepMs');
  const overallMs = bounded(timeouts.overallMs, P08_ACCEPT_MIN_TIMEOUT_MS, P08_ACCEPT_MAX_OVERALL_MS, 'overallMs');
  if (overallMs < stepMs) fail('overallMs 不能小于 stepMs');
  return { stepMs, overallMs };
}

/* ------------------------------------------------------------------ *
 * 运行身份：runId、受测 commit、输入摘要与工具链；证据引用绑定同一身份；
 * 运行目录一次性预留，旧运行目录不可被覆盖。
 * ------------------------------------------------------------------ */

export type P08RunIdentityToolchain = { readonly node: string; readonly npm: string; readonly platform: string };
export type P08RunIdentity = { readonly runId: string; readonly testedCommit: string; readonly inputsDigest: string; readonly toolchain: P08RunIdentityToolchain };
export type P08EvidenceIdentityRef = { readonly runId: string; readonly testedCommit: string; readonly inputsDigest: string };
const FROZEN_IDENTITY_TOOLCHAIN: P08RunIdentityToolchain = { node: P08_TOOLCHAIN.node, npm: P08_TOOLCHAIN.npm, platform: P08_TOOLCHAIN.platform };

export function validateP08RunIdentity(value: unknown): P08RunIdentity {
  const raw = object(value, 'runIdentity');
  keys(raw, ['runId', 'testedCommit', 'inputsDigest', 'toolchain'], 'runIdentity');
  for (const key of ['runId', 'testedCommit', 'inputsDigest', 'toolchain'] as const) if (!(key in raw)) fail(`runIdentity 缺少字段：${key}`);
  if (typeof raw.runId !== 'string' || !SAFE_ID_PATTERN.test(raw.runId)) fail('runId 必须是安全标识符（不含路径分隔或越界长度）');
  if (typeof raw.testedCommit !== 'string' || !GIT_SHA_PATTERN.test(raw.testedCommit)) fail('testedCommit 必须是 40 位小写十六进制 SHA');
  if (typeof raw.inputsDigest !== 'string' || !SHA256_PATTERN.test(raw.inputsDigest)) fail('inputsDigest 必须是 64 位小写十六进制摘要');
  const toolchain = object(raw.toolchain, 'runIdentity.toolchain');
  keys(toolchain, ['node', 'npm', 'platform'], 'runIdentity.toolchain');
  same(toolchain, FROZEN_IDENTITY_TOOLCHAIN, 'runIdentity.toolchain');
  return { runId: raw.runId, testedCommit: raw.testedCommit, inputsDigest: raw.inputsDigest, toolchain: FROZEN_IDENTITY_TOOLCHAIN };
}

export function p08RunIdentityMatches(a: P08EvidenceIdentityRef, b: P08EvidenceIdentityRef): boolean {
  return a.runId === b.runId && a.testedCommit === b.testedCommit && a.inputsDigest === b.inputsDigest;
}

/** 证据引用身份绑定：报告与证据引用必须绑定同一 runId/受测 commit/输入摘要，漂移 fail-closed。 */
export function validateP08EvidenceIdentityBinding(evidence: P08EvidenceIdentityRef, expected: P08EvidenceIdentityRef, label = 'evidence'): void {
  const evidenceIdentity = validateP08RunIdentity({ ...evidence, toolchain: FROZEN_IDENTITY_TOOLCHAIN });
  if (!p08RunIdentityMatches(evidenceIdentity, expected)) {
    throw new P08AcceptError('identity_mismatch', `${label} 与运行身份不匹配`, `evidence=${evidenceIdentity.runId}/${evidenceIdentity.testedCommit}/${evidenceIdentity.inputsDigest}`);
  }
}

export type P08RunDirectoryDisposition = { readonly action: 'create' } | { readonly action: 'fail'; readonly reason: 'run-directory-exists'; readonly detail: string };

/** 运行目录处置：已存在的 runId 目录不可覆盖，保留旧运行并失败退出。 */
export function p08RunDirectoryDisposition(input: { readonly runId: string; readonly directoryExists: boolean }): P08RunDirectoryDisposition {
  if (typeof input.runId !== 'string' || !SAFE_ID_PATTERN.test(input.runId)) fail('runId 必须是安全标识符（不含路径分隔或越界长度）');
  if (input.directoryExists) {
    return { action: 'fail', reason: 'run-directory-exists', detail: `运行目录已存在，保留旧运行并拒绝覆盖：${input.runId}` };
  }
  return { action: 'create' };
}

/* ------------------------------------------------------------------ *
 * 前置门槛：P08-1～P08-3 交付证据、公开接口与提交祖先关系
 * ------------------------------------------------------------------ */

export type P08PrerequisiteInput = {
  readonly feature: string;
  readonly commit: string;
  readonly delivered: boolean;
  readonly interfacesSatisfied: boolean;
  /** 交付证据引用（如交付报告/发布清单/live 入口文档路径或摘要）；空即视为证据缺失。 */
  readonly deliveryEvidence: readonly string[];
  /** 已核验的公开接口清单；空即视为公开接口未核验。 */
  readonly publicInterfaces: readonly string[];
  /** 前序 commit 是否为受测 HEAD 的祖先（由入口用 git merge-base 核验后传入）。 */
  readonly ancestorOfHead: boolean;
};
export type P08PrerequisiteBlockerCode =
  | 'not_delivered' | 'interfaces_unsatisfied' | 'invalid_commit' | 'evidence_missing' | 'interfaces_missing' | 'not_ancestor';
export type P08PrerequisiteEvaluation = {
  readonly status: 'satisfied' | 'blocked';
  readonly resultStatus: 'pass' | 'not_run';
  readonly blockedFeatures: readonly string[];
  readonly blockers: readonly { readonly feature: string; readonly code: P08PrerequisiteBlockerCode; readonly detail: string }[];
  readonly reason: string;
};

export function evaluateP08Prerequisites(inputs: readonly P08PrerequisiteInput[]): P08PrerequisiteEvaluation {
  const byFeature = new Map<string, P08PrerequisiteInput>();
  for (const input of inputs) {
    if (typeof input.feature !== 'string' || !P08_PREREQUISITE_FEATURES.includes(input.feature as P08PrerequisiteFeature)) fail(`前置输入含未知 Feature：${String(input.feature)}`);
    if (byFeature.has(input.feature)) fail(`前置输入含重复 Feature：${input.feature}`);
    if (typeof input.commit !== 'string') fail(`前置输入 ${input.feature}.commit 必须是字符串`);
    if (typeof input.delivered !== 'boolean' || typeof input.interfacesSatisfied !== 'boolean' || typeof input.ancestorOfHead !== 'boolean') fail(`前置输入 ${input.feature} 的布尔字段非法`);
    if (!Array.isArray(input.deliveryEvidence) || !Array.isArray(input.publicInterfaces) ||
        input.deliveryEvidence.some(entry => typeof entry !== 'string' || entry.length === 0) ||
        input.publicInterfaces.some(entry => typeof entry !== 'string' || entry.length === 0)) fail(`前置输入 ${input.feature} 的证据/接口清单必须是非空字符串数组`);
    byFeature.set(input.feature, input);
  }
  const blockers: { feature: string; code: P08PrerequisiteBlockerCode; detail: string }[] = [];
  for (const feature of P08_PREREQUISITE_FEATURES) {
    const input = byFeature.get(feature);
    if (!input) { blockers.push({ feature, code: 'not_delivered', detail: '缺少前置输入，按未交付处理' }); continue; }
    if (input.delivered !== true) blockers.push({ feature, code: 'not_delivered', detail: 'delivered 不为 true' });
    if (input.interfacesSatisfied !== true) blockers.push({ feature, code: 'interfaces_unsatisfied', detail: '公开接口不满足（疑似占位实现）' });
    if (!GIT_SHA_PATTERN.test(input.commit)) blockers.push({ feature, code: 'invalid_commit', detail: 'commit 不是 40 位小写十六进制 SHA' });
    if (input.deliveryEvidence.length === 0) blockers.push({ feature, code: 'evidence_missing', detail: '缺少交付证据引用' });
    if (input.publicInterfaces.length === 0) blockers.push({ feature, code: 'interfaces_missing', detail: '缺少已核验公开接口清单' });
    if (input.ancestorOfHead !== true) blockers.push({ feature, code: 'not_ancestor', detail: '前序提交不是受测 HEAD 的祖先' });
  }
  if (blockers.length === 0) {
    return { status: 'satisfied', resultStatus: 'pass', blockedFeatures: [], blockers: [], reason: '前序 P08-1～P08-3 均已交付、接口满足且提交祖先关系成立' };
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
 * 两类 live 证据分别核对：Todo 新项目与存量项目互不替代
 * ------------------------------------------------------------------ */

export type P08LiveEvidenceInput = {
  readonly kind: string;
  readonly reportPresent: boolean;
  /** 报告声明的证据 kind（如 shiploop.todo.live-evidence）；null 表示报告缺失。 */
  readonly reportKind: string | null;
  readonly identityBound: boolean | null;
  readonly realModelUsed: boolean | null;
  readonly ownerConfirmed: boolean | null;
};
export type P08LiveEvidenceEvaluation = { readonly kind: P08LiveKind; readonly status: P08ReportStatus; readonly reason: string };

export function evaluateP08LiveEvidence(input: P08LiveEvidenceInput): P08LiveEvidenceEvaluation {
  if (!P08_LIVE_KINDS.includes(input.kind as P08LiveKind)) fail(`未知 live 证据类别：${String(input.kind)}`);
  const kind = input.kind as P08LiveKind;
  const expectedKind = P08_LIVE_EVIDENCE_KINDS[kind];
  if (!input.reportPresent) return { kind, status: 'not_run', reason: 'live-evidence-missing：真实模型或证据缺失保持 not_run，不折算通过' };
  if (input.reportKind !== expectedKind) {
    const otherKind = P08_LIVE_KINDS.find(candidate => P08_LIVE_EVIDENCE_KINDS[candidate] === input.reportKind);
    return { kind, status: 'fail', reason: otherKind ? `live-evidence-kind-invalid：两类 live 证据不可互相替代（期望 ${expectedKind}，实际 ${String(input.reportKind)}）` : `live-evidence-kind-invalid：期望 ${expectedKind}，实际 ${String(input.reportKind)}` };
  }
  if (input.identityBound !== true) return { kind, status: 'fail', reason: 'live-evidence-identity-unbound：证据未绑定运行身份（runId/受测 commit/输入摘要）' };
  if (input.realModelUsed === false) return { kind, status: 'fail', reason: 'live-model-not-real：确定性/Fake 结果不得冒充真实模型 live 证据' };
  if (input.realModelUsed === null) return { kind, status: 'not_run', reason: 'live-model-unverified：真实模型使用情况未核实，保持 not_run' };
  if (input.ownerConfirmed !== true) return { kind, status: 'not_run', reason: 'owner-unconfirmed：负责人未确认，保持 not_run' };
  return { kind, status: 'pass', reason: `真实 live 证据核验通过（${expectedKind}）` };
}

/* ------------------------------------------------------------------ *
 * Nezha 边界：Harness 状态、测试数量与成功日志文字不作为产品通过依据
 * ------------------------------------------------------------------ */

export type P08HarnessEvidenceClaim = { readonly harnessState?: boolean; readonly testCountOnly?: boolean; readonly successLogText?: boolean; readonly productFactRef?: boolean };

export function p08HarnessEvidenceAdmissible(claim: P08HarnessEvidenceClaim): boolean {
  return claim.productFactRef === true && claim.harnessState !== true && claim.testCountOnly !== true && claim.successLogText !== true;
}

/* ------------------------------------------------------------------ *
 * 严格三态聚合：缺失结果/负责人未确认记 not_run；缺证据类别记 fail
 * ------------------------------------------------------------------ */

export type P08CheckResult = { readonly checkId: string; readonly status: P08ReportStatus; readonly executionMode: 'fake' | 'live' | 'manual'; readonly evidence?: readonly string[]; readonly manualStatus?: 'pending' | 'confirmed' | 'rejected'; readonly reason?: string };
export type P08AggregatedCheck = P08FrozenItem & { readonly status: P08ReportStatus; readonly reason?: string; readonly executionMode?: string };
export type P08Aggregate = { readonly checks: readonly P08AggregatedCheck[]; readonly counts: { readonly pass: number; readonly fail: number; readonly not_run: number }; readonly conclusion: 'pass' | 'fail' };
export function aggregateP08CheckResults(checklist: P08Checklist, results: readonly P08CheckResult[]): P08Aggregate {
  const byId = new Map<string, P08CheckResult>();
  for (const result of results) { if (!ITEM_BY_ID.has(result.checkId)) throw new P08AcceptError('invalid_config', `结果含未知检查：${result.checkId}`); if (byId.has(result.checkId)) throw new P08AcceptError('invalid_config', `结果含重复检查：${result.checkId}`); byId.set(result.checkId, result); }
  const checks = checklist.items.map(item => {
    const result = byId.get(item.id);
    // 缺失输入不默认为通过：未提供结果的必需检查保持 not_run。
    if (!result) return { ...item, status: 'not_run' as const, reason: '未提供结果' };
    if (result.status === 'not_run') return { ...item, status: 'not_run' as const, reason: result.reason ?? '执行类别未运行', executionMode: result.executionMode };
    if (result.status === 'fail') return { ...item, status: 'fail' as const, reason: result.reason ?? '检查失败', executionMode: result.executionMode };
    const requiredEvidence = new Set(item.evidence);
    const actualEvidence = new Set(result.evidence ?? []);
    const missingEvidence = [...requiredEvidence].filter(category => !actualEvidence.has(category));
    const modeValid = (item.execution === 'offline' && result.executionMode === 'fake') || (item.execution === 'live' && result.executionMode === 'live') || (item.execution === 'manual' && result.executionMode === 'manual');
    // 负责人未确认保持 not_run（PRD AC-3），机器不可代签。
    const pending = item.execution === 'manual' && result.manualStatus !== 'confirmed';
    if (missingEvidence.length > 0) return { ...item, status: 'fail' as const, reason: `缺少证据：${missingEvidence.join(',')}`, executionMode: result.executionMode };
    if (!modeValid) return { ...item, status: 'fail' as const, reason: `执行类别不匹配：${result.executionMode}`, executionMode: result.executionMode };
    if (pending) return { ...item, status: 'not_run' as const, reason: '负责人未确认（pending/rejected），保持 not_run', executionMode: result.executionMode };
    return { ...item, status: 'pass' as const, executionMode: result.executionMode };
  });
  const requiredChecks = checks.filter(check => check.group !== 'deferred');
  const counts = { pass: requiredChecks.filter(check => check.status === 'pass').length, fail: requiredChecks.filter(check => check.status === 'fail').length, not_run: requiredChecks.filter(check => check.status === 'not_run').length };
  const conclusion = requiredChecks.every(check => check.status === 'pass') ? 'pass' : 'fail';
  return { checks, counts, conclusion };
}

// Compatibility surface for later P08-4 tasks (identity/scope/import/install/report/entry).
export type P08ChecklistItem = P08FrozenItem;
export const P08_ACCEPT_MIN_TIMEOUT_MS = 1_000;
export const P08_ACCEPT_MAX_TIMEOUT_MS = 7_200_000;
export const P08_ACCEPT_MAX_OVERALL_MS = 14_400_000;
export const P08_ACCEPT_MIN_OUTPUT_BYTES = 1_024;
export const P08_ACCEPT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
