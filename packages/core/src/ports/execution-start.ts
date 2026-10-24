/**
 * P03-3 / F-005 显式 ExecutionController 启动契约（ports 契约层：操作常量、
 * workKey 纯函数、派发唤醒窄端口与事务外准备/事务内提交的端口形态，无 I/O）。
 *
 * 设计依据：core-design/04 §6.1（Run 外层的 ExecutionController：显式调用
 * StateStore 创建 Run；所有 Run 必须归属用户明确授权的 ExecutionBatch；禁止
 * 通过创建子批次或换 Run ID 绕过预算；同 Batch 的 workKey 由 Feature、用途、
 * 计划/需求输入摘要决定；同 workKey 已成功不得再次自动创建 Run；显式重试失败
 * 工作增加 dispatchOrdinal 但共享预算；所有计数与对象创建在同一事务）、
 * core-design/04 §1（内存唤醒只降低延迟，定期扫描补偿丢失唤醒——唤醒失败
 * 不重复创建 Run，可从持久状态核对）、core-design/08 §9（startBatch 携带预览
 * 摘要；启动事务重核实际范围与前置条件，实质变化返回 preview_stale；没有
 * 待执行项返回 no_work 不创建空批次）、docs/p03-3-execution-preview-contract.md
 * （previewDigest 完整输入身份）、docs/p03-3-work-command-receipts-contract.md
 * （Work accepted v6：operationId=batchId、真实 Batch/Run 关联）。
 * 实施契约：docs/p03-3-execution-start-contract.md。
 *
 * 契约要点：
 * - 命令面 `execution.start`（capability `execution.start`，与 execution.preview
 *   共享授权面）；创建类不携带 expectedRevision；payload 冻结为
 *   { featureIds, budget, previewDigest, retryBatchId? }：featureIds 固定单成员，
 *   budget 为完整预算提案（深校验复用 ports/execution-budget 权威校验器），
 *   previewDigest 为用户确认的预览摘要（64hex；服务端重算比对），retryBatchId
 *   仅用于同父 Batch 的显式失败重试（不携带则创建新 Batch = 新的明确授权）；
 * - 编排分两段：事务外准备（有界输入核验 + 只读预览重算，全部仓库/制品 I/O
 *   在写事务之外）→ 短写事务内提交（项目 active、Phase 可执行、批准依据、
 *   预览身份、活动执行与预算全部在同一权威写事务内重核；漂移固化 rejected
 *   preview_stale，零创建零扣额）；
 * - 首次明确授权创建一个单 Feature Batch + 一个 Run（runsCreated=1；Batch/Run
 *   快照、初始预算修订行、accepted v6 回执与脱敏 state_event 同事务成功或全部
 *   回滚，返回真实 Batch/Run ID）；Runtime 启动数恒为零（runtime_starts=0；
 *   accepted 不改变 Task passed 或 Feature completed，不代表已启动任何进程）；
 * - 幂等：同 commandId 完整重放返回原 accepted 回执（同 Batch/Run），不再次扣额
 *   或唤醒；复用 commandId 异参由命令面 requestDigest 拒绝（conflict）；
 * - 后续显式重试失败工作携带 retryBatchId：同一父 Batch 原子递增
 *   dispatchOrdinal 与 runsCreated，仍受父预算（maxRuns/deadline）；终态 Run
 *   不重开（重试创建新 Run 行）；同 Batch 已成功 workKey 拒绝再派发；
 * - workKey 固定 Feature、用途与有效计划/需求输入身份（不含代码身份：失败
 *   重试后代码进展不改变工作身份）；成功、失败和取消 Run 均不退还 Run 次数；
 *   新 Batch 只能来自新的明确用户授权（不带 retryBatchId 的新命令），控制层
 *   不得自动创建子批次或扩大授权范围；
 * - 唤醒：仅在写事务成功提交后经窄端口 ExecutionDispatchSignalPort 发出（事务
 *   失败不得唤醒；重放不唤醒）；唤醒丢失或失败不重复创建 Run——持久状态
 *   （queued Run）是权威，可从数据库核对；无 Scheduler/Runtime 装配时 Run
 *   保留 queued 状态并携带可查询原因（scheduler_not_assembled），不伪造完成
 *   或提前启动进程；
 * - 秘密纪律：结果/错误/快照只含身份键、摘要、受控原因与有界计数，不含
 *   绝对路径、制品正文或凭据。
 *
 * 实现者：application/execution-start.ts（启动编排）；命令面接线见
 * ports/commands.ts（execution.start）与 application/command-service.ts（事务外
 * 准备 + 事务内提交 + 提交后唤醒）；存储原语见 ports/execution-store.ts。
 * Host/CLI 传输入口与 HostClient 方法属后续接线任务（F-011/F-012）。
 */
import { createHash } from 'node:crypto';
import { stableStringify } from './feature-plan.js';
import type { CommandReceipt, CommandScope, ValidatedExecutionPreviewPayload } from './commands.js';
import type { CommandTransaction } from './atomic-commands.js';
import type {
  ExecutionBudgetProposal,
  ExecutionBudgetSnapshot,
} from './execution-budget.js';
import type {
  ExecutionPreviewCodeIdentity,
  ExecutionPreviewInputRefSummary,
  ExecutionPreviewResult,
} from './execution-preview.js';
import type { ValidatedExecutionStartPayload } from './commands.js';

/** 显式执行启动命令操作名（COMMAND_OPERATIONS 白名单冻结名）。 */
export const EXECUTION_START_OPERATION = 'execution.start' as const;

/** workKey 领域前缀：把摘要锚定到「单 Feature 执行工作身份 v1」语义。 */
export const EXECUTION_WORK_KEY_DOMAIN = 'shiploop:execution-work-key:v1';

/**
 * 本阶段唯一执行用途：单 Feature 实施/修复执行。规划用途（plan）与多 Feature
 * 跑批属后续路线；workKey 携带用途使未来用途不与执行工作冲突。
 */
export const EXECUTION_RUN_PURPOSE = 'execute' as const;

/**
 * 无 Scheduler/Runtime 装配时的可查询排队原因（Run 行 reason 列；F-010 查询面
 * 读取）：派发已持久化但没有装配调度器/运行时，保持 queued，不伪造完成。
 */
export const EXECUTION_RUN_NOT_READY_REASON = 'scheduler_not_assembled' as const;

/**
 * 拒绝回执 reason 词汇（冻结）：
 * - preview_stale：预览身份/前置条件漂移（含 no_work/blocked 当前状态与批准失效）；
 * - budget_exhausted：父预算（计数/deadline）不再允许新派发；
 * - batch_not_active：重试目标 Batch 已终态或已持久化暂停意图（授权关闭，
 *   新 Run 需显式恢复/新授权）；
 * - retry_scope_mismatch：重试目标 Batch 范围与命令范围不一致；
 * - retry_work_key_absent：重试目标 Batch 中不存在该工作身份的 Run（计划/输入
 *   已实质变化，属新工作，需新的明确授权）；
 * - work_key_succeeded：同 Batch 该工作身份已成功，拒绝再派发。
 */
export const EXECUTION_START_REJECTED_REASONS = [
  'preview_stale',
  'budget_exhausted',
  'batch_not_active',
  'retry_scope_mismatch',
  'retry_work_key_absent',
  'work_key_succeeded',
] as const;
export type ExecutionStartRejectedReason = (typeof EXECUTION_START_REJECTED_REASONS)[number];

/** 抛出型冲突 reason（不落回执，客户端可换 commandId 重试）：活动执行争抢。 */
export const EXECUTION_IN_PROGRESS_REASON = 'execution_in_progress' as const;

/* ------------------------------------------------------------------ *
 * workKey（纯函数：逻辑工作去重键）
 * ------------------------------------------------------------------ */

/** computeExecutionWorkKey 输入（身份级；不含代码身份与预算）。 */
export interface ExecutionWorkKeyInput {
  readonly featureId: string;
  readonly purpose: string;
  /** 有效计划摘要（批准绑定的当前 planDigest）。 */
  readonly planDigest: string;
  /** 必需不可变输入的解析身份（artifactId+version+contentHash；稳定排序）。 */
  readonly inputs: readonly ExecutionPreviewInputRefSummary[];
}

/**
 * 逻辑工作去重键：SHA-256(`${EXECUTION_WORK_KEY_DOMAIN}\n${canonical}`)。
 * canonical 为稳定规范化 JSON（键排序；输入按 artifactId 稳定排序）。
 * 成分 = Feature + 用途 + 有效计划摘要 + 必需输入解析身份：实质计划修订或
 * 输入内容变化 → 新工作；代码进展（失败重试后的提交/工作区变化）与预算调整
 * 不改变工作身份（预算修订不产生新工作）。
 */
export function computeExecutionWorkKey(input: ExecutionWorkKeyInput): string {
  const canonical = stableStringify({
    schemaVersion: 1,
    featureId: input.featureId,
    purpose: input.purpose,
    planDigest: input.planDigest,
    inputs: [...input.inputs]
      .sort((left, right) =>
        left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0,
      )
      .map((ref) => ({
        artifactId: ref.artifactId,
        version: ref.version,
        contentHash: ref.contentHash,
      })),
  });
  return createHash('sha256').update(`${EXECUTION_WORK_KEY_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * 派发唤醒窄端口（提交后 best-effort；持久状态是权威）
 * ------------------------------------------------------------------ */

/** 提交后派发唤醒输入（身份级；不携带正文/凭据）。 */
export interface ExecutionDispatchSignalInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly featureId: string;
}

/**
 * 派发唤醒窄端口（Scheduler/扫描器装配点；实现者负责去重与补偿扫描）。
 * 契约：调用发生在写事务成功提交之后；实现抛出/丢失不得影响已提交的命令
 * 结果（调用方吞掉异常），也不得据此重复创建 Run——持久 queued Run 是权威。
 */
export interface ExecutionDispatchSignalPort {
  signalRunDispatched(input: ExecutionDispatchSignalInput): void;
}

/* ------------------------------------------------------------------ *
 * 事务外准备结果（事务内提交的输入；全部 I/O 已在事务外完成）
 * ------------------------------------------------------------------ */

/** 事务外重算的当前预览状态（非 ready 一律按漂移处理，不区分原因细目）。 */
export interface PreparedExecutionStartNotStartable {
  readonly kind: 'not_startable';
  /** 当前只读预览状态（no_work/blocked/摘要不一致）。 */
  readonly currentStatus: 'no_work' | 'blocked' | 'digest_mismatch';
}

/** 新授权就绪身份：与事务内权威重核比对的一切成分（代码身份来自事务外受控 I/O）。 */
export interface PreparedExecutionStartFresh {
  readonly kind: 'fresh';
  readonly projectId: string;
  readonly featureId: string;
  readonly scopeFeatureIds: readonly string[];
  readonly phaseId: string;
  readonly phaseRevision: number | null;
  readonly memberRevisions: readonly { readonly featureId: string; readonly revision: number; readonly planDigest: string | null }[];
  /** 用户确认的预览摘要（= 当前重算摘要；不一致时准备结果为 not_startable）。 */
  readonly previewDigest: string;
  readonly budget: ExecutionBudgetProposal;
  readonly code: ExecutionPreviewCodeIdentity;
  readonly inputs: readonly ExecutionPreviewInputRefSummary[];
  readonly planDigest: string;
  readonly checkPolicyDigest: string;
  readonly decisionId: string | null;
  readonly taskStrategyDigests: readonly { readonly taskId: string; readonly digest: string }[];
  readonly permissionDigests: readonly { readonly taskId: string; readonly digest: string }[];
  readonly pendingTaskIds: readonly string[];
  readonly generatedAtUtcMs: number;
}

/**
 * 同父 Batch 显式重试准备：不重算预览（父 Batch 自身即同 Phase 活动位，新授权
 * 预览必报 active_batch_in_phase blocked）；重试的工作身份由 workKey（事务内以
 * 权威视图计算）与父 Batch 既有 Run 绑定，预算共享父 Batch 冻结预算。
 */
export interface PreparedExecutionStartRetry {
  readonly kind: 'retry';
  readonly projectId: string;
  /** 请求必须完整复述父 Batch 的冻结成员集合。 */
  readonly scopeFeatureIds: readonly string[];
  /** 兼容单成员调用方的首个成员身份。 */
  readonly featureId: string;
  readonly retryBatchId: string;
}

export type PreparedExecutionStart =
  | PreparedExecutionStartNotStartable
  | PreparedExecutionStartFresh
  | PreparedExecutionStartRetry;

/** 命令身份（回执字段的服务端可信来源）。 */
export interface ExecutionStartCommandIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly scope: CommandScope;
  readonly requestDigest: string;
  readonly issuedAt: string;
}

/** 事务内提交上下文（由命令服务传入的装配事实，不来自请求）。 */
export interface ExecutionStartSubmitContext {
  /** 是否装配了派发唤醒端口（决定 Run 排队原因的可查询形态）。 */
  readonly schedulerAssembled: boolean;
}

/** 事务内提交使用的命令信封最小面（scope/payload；操作固定 execution.start）。 */
export interface ExecutionStartEnvelopeFace {
  readonly scope: { readonly kind: 'project'; readonly projectId: string };
  readonly payload: ValidatedExecutionStartPayload;
}

/**
 * 显式执行启动端口：prepareExecutionStart 在写事务之外完成有界输入核验与
 * 只读预览重算（全部仓库/制品 I/O 在事务外）；submitExecutionStart 在调用方
 * 的同一 BEGIN IMMEDIATE 短写事务内重核全部前置条件并原子提交 Batch/Run/
 * 预算修订行/脱敏事件/accepted v6 回执。实现者：createExecutionStartService。
 */
export interface ExecutionStartPort {
  prepareExecutionStart(
    projectId: string,
    payload: ValidatedExecutionStartPayload,
  ): Promise<PreparedExecutionStart>;
  submitExecutionStart(
    identity: ExecutionStartCommandIdentity,
    envelope: ExecutionStartEnvelopeFace,
    transaction: CommandTransaction,
    prepared: PreparedExecutionStart,
    context: ExecutionStartSubmitContext,
  ): CommandReceipt;
}

/**
 * 启动编排消费的最小预览端口面（结构化子集；实现者为 F-004 预览服务——
 * application/execution-preview 的 ExecutionPreviewPort 满足本形状，ports 层
 * 不反向依赖 application 层，以本地最小面声明）。
 */
export interface ExecutionStartPreviewPort {
  previewExecution(
    projectId: string,
    payload: ValidatedExecutionPreviewPayload,
  ): Promise<ExecutionPreviewResult>;
}
