/**
 * P03-3 / F-004 单 Feature 执行 prepare 预览窄契约（ports 契约层：类型、常量、
 * 纯摘要函数与一致读视图端口形态，无任何 I/O）。
 *
 * 设计依据：core-design/08 §9（prepareExecution：Core 确定性计算候选范围、策略、
 * 检查、代码基线、预算与阻塞原因，不调用模型决定调度；返回预览内容与摘要，
 * 不预先创建 Run/Attempt；预览不是批准记录或永久占用）、core-design/04 §6
 * （所有 Run 必须归属用户明确授权的 ExecutionBatch；本阶段范围恰为一个
 * Feature，不自动扩大）、docs/p03-3-execution-budget-contract.md（预算提案
 * 权威校验与并发政策契约）、docs/p03-2-plan-approval-verification-contract.md
 * （批准复合身份 = planDigest + 检查政策内容摘要）。
 * 实施契约：docs/p03-3-execution-preview-contract.md（本模块契约文档）。
 *
 * 契约要点：
 * - 命令面 `execution.preview`（capability `execution.start`；与后续 F-005 启动
 *   命令同一授权面，参照 baseline.preview/baseline.run 共享 baseline.run 的先例）；
 *   只读预览：不创建 Batch/Run/Attempt、不扣预算、不调用 Runtime/Git 写操作、
 *   不安装依赖、不探测真实模型、不加载未选全局资源；
 * - 范围固定单成员：scope.featureIds 恰含目标 Feature；请求携带空范围返回
 *   no_work（empty_scope），携带多成员范围结构化拒绝（本阶段不支持多 Feature
 *   跑批）；预览绝不自动加入其他 Feature、依赖节点或 Phase 后续新增成员；
 * - 状态词汇：ready（可启动授权依据）/ no_work（empty_scope 或
 *   no_pending_tasks）/ blocked（携带全部可理解阻塞原因，不静默取舍）；
 *   blocked 不是错误：调用方可展示原因并修复后重试；跨项目 Feature、非法预算、
 *   未支持的有效并发大于一及不安全仓库绑定是结构化拒绝（PublicError），
 *   不是 blocked 状态；
 * - previewDigest 是完整输入身份（需求 planDigest、代码身份、逐 Task 策略副本
 *   内容身份、检查政策摘要、权限面摘要、必需不可变输入引用的解析身份与预算
 *   提案）：任一实质变化改变摘要；纯标签等无关元数据不参与（labels 不进入
 *   planDigest/策略副本/权限/输入解析身份，与 P03-2 逐身份同一纪律）；
 * - 一致读视图（ExecutionPreviewView）：项目状态、绑定、Phase、Feature、全部
 *   Task/依赖边/决策记录、全局与项目当前配置、必需输入解析、活动 Run/活动
 *   Batch 与基线占用必须在同一读事务内取得（实现者：adapters/sqlite/plan-store
 *   单一 BEGIN DEFERRED 读事务）；
 * - 授权先于仓库或制品 I/O：能力/预算/并发/范围校验先于 repositoryInspector
 *   与工作区读取（realpath、仓库身份复用 ports/repository-inspector；必需
 *   不可变输入引用复用 ArtifactStore.getArtifactInputRef 同一契约语义，正文
 *   永不内联）；blocked 结果不做仓库 I/O；
 * - 预览不宣称已具备 Runtime 执行能力：结果恒携带 runtimeExecution=false；
 *   budget 授权预览只确认预算提案合法，不代表 Runtime 可用或已启动；
 * - 秘密纪律：结果与错误只含身份键、摘要、受控原因与有界计数，不含绝对
 *   路径、正文内容或凭据。
 *
 * 实现者：application/execution-preview.ts（预览编排）；命令面接线见
 * ports/commands.ts（execution.preview）与 application/command-service.ts。
 * Host/CLI 传输接线与启动命令（execution.start）属后续任务。
 */
import { createHash } from 'node:crypto';
import { stableStringify } from './feature-plan.js';
import type { PreparationSettingsScopeSnapshot } from './execution-input-prepare.js';
import type {
  FeatureRecord,
  PhaseRecord,
  PlanApprovalRecord,
  TaskDependencyRecord,
  TaskRecord,
} from './plan-store.js';
import type { ProjectStatus } from './state-store.js';
import type { BatchBudgetLimits, ExecutionBudgetProposal, RunBudgetLimits } from './execution-budget.js';

/** 单 Feature 执行 prepare 预览命令操作名（与 COMMAND_OPERATIONS 白名单同一冻结名）。 */
export const EXECUTION_PREVIEW_OPERATION = 'execution.preview' as const;

/** 预览结果结构版本；未知/未来版本 fail-closed 拒绝。 */
export const EXECUTION_PREVIEW_RESULT_SCHEMA_VERSION = 1;

/** previewDigest 领域前缀：把摘要锚定到「单 Feature 执行预览身份 v1」语义。 */
export const EXECUTION_PREVIEW_DIGEST_DOMAIN = 'shiploop:execution-preview:v1';

/**
 * 有效活动执行状态集合（与迁移 v9 条件唯一部分索引同源）：终态
 * （cancelled/succeeded/failed）不占用；paused/interrupted 不是可绕过的终态。
 */
export const ACTIVE_EXECUTION_STATUSES = [
  'queued',
  'running',
  'pausing',
  'paused',
  'cancelling',
  'interrupted',
] as const;
export type ActiveExecutionStatus = (typeof ACTIVE_EXECUTION_STATUSES)[number];

/**
 * 待执行工作的 Task 状态集合：pending（尚未执行）与 failed（显式返工候选）。
 * passed/skipped/cancelled 视为本次范围内无待执行工作（no_work 判定输入）。
 */
export const EXECUTION_PREVIEW_PENDING_WORK_TASK_STATUSES = ['pending', 'failed'] as const;

/** 预览状态词汇（冻结）：ready / no_work / blocked。 */
export const EXECUTION_PREVIEW_STATUSES = ['ready', 'no_work', 'blocked'] as const;
export type ExecutionPreviewStatus = (typeof EXECUTION_PREVIEW_STATUSES)[number];

/** no_work 原因词汇（冻结）：空范围 / 范围内无待执行工作。 */
export const EXECUTION_PREVIEW_NO_WORK_REASONS = ['empty_scope', 'no_pending_tasks'] as const;
export type ExecutionPreviewNoWorkReason = (typeof EXECUTION_PREVIEW_NO_WORK_REASONS)[number];

/** 阻塞原因类别词汇（冻结）。 */
export const EXECUTION_PREVIEW_BLOCKED_REASON_KINDS = [
  'plan_approval',
  'project_not_active',
  'phase_not_executable',
  'active_run',
  'active_batch_in_phase',
  'baseline_occupancy',
  'required_input_unavailable',
] as const;
export type ExecutionPreviewBlockedReasonKind =
  (typeof EXECUTION_PREVIEW_BLOCKED_REASON_KINDS)[number];

/** 批准阻塞原因：reason 为 P03-2 有效批准核验词汇（not_approved/plan_changed/…）。 */
export interface PlanApprovalBlockedReason {
  readonly kind: 'plan_approval';
  readonly reason: string;
}

export interface ProjectNotActiveBlockedReason {
  readonly kind: 'project_not_active';
  readonly status: ProjectStatus;
}

export interface PhaseNotExecutableBlockedReason {
  readonly kind: 'phase_not_executable';
  readonly status: string;
}

export interface ActiveRunBlockedReason {
  readonly kind: 'active_run';
  readonly runId: string;
  readonly status: string;
}

export interface ActiveBatchBlockedReason {
  readonly kind: 'active_batch_in_phase';
  readonly batchId: string;
  readonly featureId: string;
  readonly status: string;
}

/** 基线在途/隔离占用（保留占用即阻塞：全局单并发，未确认停止不释放）。 */
export interface BaselineOccupancyBlockedReason {
  readonly kind: 'baseline_occupancy';
  readonly holderOperationId: string;
}

/** 必需不可变输入引用不可用：not_found / not_ready / content_mismatch。 */
export interface RequiredInputUnavailableBlockedReason {
  readonly kind: 'required_input_unavailable';
  readonly artifactId: string;
  readonly detail: 'not_found' | 'not_ready' | 'content_mismatch';
}

export type ExecutionPreviewBlockedReason =
  | PlanApprovalBlockedReason
  | ProjectNotActiveBlockedReason
  | PhaseNotExecutableBlockedReason
  | ActiveRunBlockedReason
  | ActiveBatchBlockedReason
  | BaselineOccupancyBlockedReason
  | RequiredInputUnavailableBlockedReason;

/* ------------------------------------------------------------------ *
 * 一致读视图（单一读事务内取得；实现者为 SQLite 适配器）
 * ------------------------------------------------------------------ */

/** 必需不可变输入引用的一致解析结果（身份级；正文永不内联）。 */
export interface ExecutionPreviewResolvedInput {
  /** 计划内声明的引用（artifactId + 可选内容绑定摘要）。 */
  readonly artifactId: string;
  readonly declaredContentHash: string | null;
  /** 当前权威索引解析（仅 ready 制品）；不可用为 null。 */
  readonly resolved: {
    readonly version: number;
    readonly contentHash: string;
    readonly sizeBytes: number;
  } | null;
  readonly unavailableReason: 'not_found' | 'not_ready' | null;
}

/** 项目与绑定的最小只读面（预览只关心状态与身份，不复制元数据）。 */
export interface ExecutionPreviewProjectFace {
  readonly id: string;
  readonly status: ProjectStatus;
}

export interface ExecutionPreviewBindingFace {
  readonly canonicalPath: string;
  readonly repoIdentity: string;
}

/**
 * 执行预览一致读视图：项目状态、绑定、Phase、Feature、全部 Task/依赖边/决策
 * 记录、全局与项目当前配置、必需输入解析、同 Feature 活动 Run、同 Phase 活动
 * Batch 与基线占用快照。全部成分必须来自同一读事务（不存在新旧混合状态）。
 */
export interface ExecutionPreviewView {
  readonly project: ExecutionPreviewProjectFace;
  readonly binding: ExecutionPreviewBindingFace | null;
  readonly phase: PhaseRecord;
  readonly feature: FeatureRecord;
  readonly tasks: readonly TaskRecord[];
  readonly dependencies: readonly TaskDependencyRecord[];
  readonly approvals: readonly PlanApprovalRecord[];
  readonly settings: {
    readonly global: PreparationSettingsScopeSnapshot | null;
    readonly project: PreparationSettingsScopeSnapshot | null;
  };
  /** 计划内全部必需不可变输入引用（Feature sourceRefs + Task requirementsRefs 去重）。 */
  readonly resolvedInputs: readonly ExecutionPreviewResolvedInput[];
  readonly activeRuns: readonly { readonly id: string; readonly status: string }[];
  readonly activePhaseBatch:
    | { readonly id: string; readonly featureId: string; readonly status: string }
    | null;
  readonly baselineOccupancy: { readonly holderOperationId: string | null };
}

/**
 * 执行预览视图读取端口：同一读事务内返回完整视图；目标 Feature 缺失返回
 * undefined，跨项目抛 StorageError(ownership)（与既有视图读取端口同一约定）。
 */
export interface ExecutionPreviewViewStore {
  readExecutionPreviewView(
    projectId: string,
    featureId: string,
  ): ExecutionPreviewView | undefined;
}

/* ------------------------------------------------------------------ *
 * 预览结果（ready 摘要形态；正文/凭据/绝对路径永不出现）
 * ------------------------------------------------------------------ */

/** 代码身份摘要成分（真实 HEAD/工作区摘要/脏标记；来自受控仓库检查端口）。 */
export interface ExecutionPreviewCodeIdentity {
  readonly headCommit: string | null;
  readonly workingTreeDigest: string;
  readonly hasUncommittedChanges: boolean;
}

/** 逐 Task 策略摘要（策略副本内容身份 = computeExecutionStrategyCopyDigest）。 */
export interface ExecutionPreviewTaskSummary {
  readonly taskId: string;
  readonly status: string;
  readonly strategyCopyDigest: string;
  readonly strategyConfigSource: string;
}

/** 逐 Task 权限摘要（computeExecutionPermissionsDigest；可信装配读取器供料）。 */
export interface ExecutionPreviewTaskPermissions {
  readonly taskId: string;
  readonly digest: string;
}

/** 必需输入引用的解析身份（进入 previewDigest 的完整输入身份成分）。 */
export interface ExecutionPreviewInputRefSummary {
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

/** ready 预览摘要：计划/代码/Task 策略/检查/权限/预算与并发政策。 */
export interface ExecutionPreviewSummary {
  readonly approval: {
    readonly planDigest: string;
    readonly checkPolicyDigest: string;
    readonly decisionId: string | null;
  };
  readonly plan: {
    readonly planDigest: string | null;
    readonly taskCount: number;
    readonly pendingTaskIds: readonly string[];
  };
  readonly code: ExecutionPreviewCodeIdentity;
  readonly checkPolicyDigest: string;
  readonly tasks: readonly ExecutionPreviewTaskSummary[];
  readonly permissions: {
    readonly tasks: readonly ExecutionPreviewTaskPermissions[];
  };
  readonly inputs: {
    readonly refs: readonly ExecutionPreviewInputRefSummary[];
  };
  readonly budget: ExecutionBudgetProposal;
  readonly concurrency: {
    readonly maxConcurrentWorks: number;
    readonly source: string;
  };
}

/**
 * 单 Feature 执行 prepare 预览结果：
 * - status=ready：previewDigest 与 summary 非空（完整输入身份）；
 * - status=no_work：noWorkReason 非空，previewDigest/summary 为 null；
 * - status=blocked：blocked 携带全部阻塞原因（确定性顺序），previewDigest/summary
 *   为 null；
 * - runtimeExecution 恒 false：预览（含预算授权预览）不宣称已具备 Runtime
 *   执行能力，不代表已启动任何执行。
 */
export interface ExecutionPreviewResult {
  readonly schemaVersion: typeof EXECUTION_PREVIEW_RESULT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly scope: { readonly featureIds: readonly string[] };
  readonly status: ExecutionPreviewStatus;
  readonly noWorkReason: ExecutionPreviewNoWorkReason | null;
  readonly blocked: readonly ExecutionPreviewBlockedReason[];
  readonly previewDigest: string | null;
  readonly summary: ExecutionPreviewSummary | null;
  readonly runtimeExecution: false;
  readonly generatedAtUtcMs: number;
}

/* ------------------------------------------------------------------ *
 * previewDigest（纯函数：完整输入身份）
 * ------------------------------------------------------------------ */

/** computeExecutionPreviewDigest 输入（与 ExecutionPreviewSummary 同源的最小面）。 */
export interface ExecutionPreviewDigestInput {
  readonly projectId: string;
  readonly featureIds: readonly string[];
  readonly planDigest: string | null;
  readonly code: ExecutionPreviewCodeIdentity;
  readonly tasks: readonly { readonly taskId: string; readonly strategyCopyDigest: string }[];
  readonly checkPolicyDigest: string;
  readonly permissions: readonly { readonly taskId: string; readonly digest: string }[];
  readonly inputs: readonly ExecutionPreviewInputRefSummary[];
  readonly budget: { readonly batch: BatchBudgetLimits; readonly run: RunBudgetLimits };
}

/**
 * 预览身份摘要：SHA-256(`${EXECUTION_PREVIEW_DIGEST_DOMAIN}\n${canonical}`)，
 * 64 位小写十六进制。canonical 为各身份成分的稳定规范化 JSON（键排序；任务/
 * 权限/输入按身份键稳定排序），需求（planDigest）、代码、Task 策略、检查政策、
 * 权限、必需输入解析身份或预算任一实质变化即改变摘要；时间戳与标签不参与。
 */
export function computeExecutionPreviewDigest(input: ExecutionPreviewDigestInput): string {
  const canonical = stableStringify({
    schemaVersion: EXECUTION_PREVIEW_RESULT_SCHEMA_VERSION,
    projectId: input.projectId,
    scope: { featureIds: [...input.featureIds] },
    planDigest: input.planDigest,
    code: {
      headCommit: input.code.headCommit,
      workingTreeDigest: input.code.workingTreeDigest,
      hasUncommittedChanges: input.code.hasUncommittedChanges,
    },
    tasks: [...input.tasks]
      .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0))
      .map((task) => ({ taskId: task.taskId, strategyCopyDigest: task.strategyCopyDigest })),
    checkPolicyDigest: input.checkPolicyDigest,
    permissions: [...input.permissions]
      .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0))
      .map((entry) => ({ taskId: entry.taskId, digest: entry.digest })),
    inputs: [...input.inputs]
      .sort((left, right) =>
        left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0,
      )
      .map((ref) => ({
        artifactId: ref.artifactId,
        version: ref.version,
        contentHash: ref.contentHash,
      })),
    budget: { batch: input.budget.batch, run: input.budget.run },
  });
  return createHash('sha256').update(`${EXECUTION_PREVIEW_DIGEST_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}
