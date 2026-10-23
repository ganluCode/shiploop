/**
 * P05-1 / F-003 一次性规划启动契约（ports 契约层：操作常量、workKey 纯函数、
 * 拒绝原因词汇与事务外准备/事务内提交的端口形态，无 I/O）。
 *
 * 设计依据：input/p05-planning.md FR-1/FR-4（用户以需求制品、约束、验收标准
 * 和批准策略发起一次规划；Core 创建 Work purpose 的 planning Run，返回 Run 与
 * 候选身份；plan 与同项目编码排他；重复 commandId 复用原结果）、core-design/04
 * §3（planning Task 使用已确认的需求和规划输入版本，不要求存在尚未生成的有效
 * 交付计划；用户授权启动规划不等于批准它将生成的计划）、§6.1（单次规划默认
 * maxRuns=1；所有 Run 必须归属用户明确授权的 ExecutionBatch，包括单次规划；
 * 成功、失败、取消的已创建 Run 都消耗 maxRuns，不退款）、core-design/15 §2
 * （Controller 核对授权、固定 Batch 范围、预算；SQLite 是事实来源，唤醒只降低
 * 延迟）。实施契约：docs/p05-1-planning-candidate-contract.md §6/§7。
 *
 * 契约要点：
 * - 命令面 `planning.start`（复用 execution.start 能力位与授权面；创建类语义但
 *   信封为更新类：expectedRevision 是目标 Feature 聚合当前 revision 的 CAS——
 *   规划目标依据（revision/planDigest）随授权冻结，Feature 已漂移即固化
 *   rejected）；payload = F-001 一次性规划请求 v1 原样字段 + budget 完整预算
 *   提案（深校验复用 ports/execution-budget 权威校验器；单次规划固定
 *   batch.maxRuns=1，超出结构化拒绝）；
 * - 编排分两段：事务外准备（请求校验与 inputDigest、预算深校验；无仓库/
 *   模型 I/O——规划不需要预览重算或代码身份）→ 短写事务内提交（项目 active、
 *   Phase open、Feature 归属与 revision CAS、终态不可重规划、同项目活动规划/
 *   编码（含 paused/interrupted 未确认停止）、活动规划上下文、基线占用与预算
 *   在同一权威写事务内重核；通过后原子写入单 Feature 授权 Batch、purpose=plan
 *   Run、planning Task/上下文、初始预算修订行、持久派发意图、脱敏事件与
 *   accepted v7 回执；任一失败整组回滚）；
 * - 首次规划不借用编码计划审批作为规划授权（Feature plan_status=draft 即可
 *   规划；批准状态不是前置条件也不是障碍）；不在命令提交中启动模型
 *   （runtime_starts 保持 0，Run 保持 queued，planning Task 恒 pending）；
 * - 幂等由命令面 commandId 回执机制承担：重放在命令服务事务内返回原回执，
 *   不再次扣额、不重复派发或唤醒；
 * - 提交后仅 best-effort 唤醒（窄端口信号；丢失唤醒不丢持久 queued Run 与
 *   入队意图）；不自动创建子 Batch、不自动重复规划；
 * - 秘密纪律：快照/回执/事件只含身份键、摘要、受控原因与有界计数。
 *
 * 实现者：application/planning-start.ts（启动编排）；命令面接线见
 * ports/commands.ts（planning.start）与 application/command-service.ts。
 */
import { createHash } from 'node:crypto';
import { stableStringify } from './feature-plan.js';
import type { CommandReceipt, CommandScope } from './commands.js';
import type { CommandTransaction } from './atomic-commands.js';
import type { ExecutionBudgetProposal } from './execution-budget.js';
import type { ValidatedPlanningRequest } from './planning-candidates.js';

/** 一次性规划启动命令操作名（COMMAND_OPERATIONS 白名单冻结名）。 */
export const PLANNING_START_OPERATION = 'planning.start' as const;

/** planning workKey 领域前缀：把摘要锚定到「单 Feature 一次规划工作身份 v1」。 */
export const PLANNING_WORK_KEY_DOMAIN = 'shiploop:planning-work-key:v1';

/**
 * 单次规划 Batch 的固定 maxRuns（core-design/04 §6.1：单次规划默认 maxRuns=1；
 * 本命令不接受更大提案——重复规划只能由新的明确用户授权发起新命令）。
 */
export const PLANNING_START_FIXED_MAX_RUNS = 1;

/**
 * 拒绝回执 reason 词汇（冻结）：
 * - target_stale：目标依据漂移（项目非 active、Phase 非 open、负载 Phase 与
 *   Feature 归属不一致）；
 * - conflict：信封 expectedRevision 与 Feature 当前 revision 不匹配（旧 CAS）；
 * - feature_terminal：Feature 已处于终态（completed/partial/failed），不满足
 *   安全重规划条件；
 * - artifact_not_usable：需求制品引用未就绪或内容摘要不一致；
 * - budget_exhausted：准备与提交之间绝对 deadline 已到达（新批次零用量的
 *   计数上限不可能耗尽）。
 */
export const PLANNING_START_REJECTED_REASONS = [
  'target_stale',
  'conflict',
  'feature_terminal',
  'artifact_not_usable',
  'budget_exhausted',
] as const;
export type PlanningStartRejectedReason = (typeof PLANNING_START_REJECTED_REASONS)[number];

/** 抛出型冲突 reason（不落回执，客户端可换 commandId 重试）。 */
export const EXECUTION_IN_PROGRESS_REASON = 'execution_in_progress' as const;
export const PLANNING_IN_PROGRESS_REASON = 'planning_in_progress' as const;

/* ------------------------------------------------------------------ *
 * workKey（纯函数：一次规划的逻辑工作去重键）
 * ------------------------------------------------------------------ */

/** computePlanningWorkKey 输入（身份级；不含预算）。 */
export interface PlanningWorkKeyInput {
  readonly featureId: string;
  /** 规划请求语义身份（F-001 computePlanningInputDigest）。 */
  readonly inputDigest: string;
}

/**
 * 一次规划的逻辑工作去重键：SHA-256(`${PLANNING_WORK_KEY_DOMAIN}\n${canonical}`)。
 * 成分 = Feature + 规划请求语义身份：需求/约束/验收/策略实质变化 → 新规划工作。
 */
export function computePlanningWorkKey(input: PlanningWorkKeyInput): string {
  const canonical = stableStringify({
    schemaVersion: 1,
    featureId: input.featureId,
    inputDigest: input.inputDigest,
  });
  return createHash('sha256').update(`${PLANNING_WORK_KEY_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * 事务外准备结果（事务内提交的输入；无外部 I/O）
 * ------------------------------------------------------------------ */

/** 事务外就绪身份：已校验的规划请求（含 inputDigest）与预算提案。 */
export interface PreparedPlanningStart {
  readonly kind: 'fresh';
  readonly projectId: string;
  /** F-001 已校验规划请求（schemaVersion/inputDigest 与全部语义字段）。 */
  readonly request: ValidatedPlanningRequest;
  /** 深校验后的完整预算提案（batch.maxRuns 固定为 1）。 */
  readonly budget: ExecutionBudgetProposal;
  readonly generatedAtUtcMs: number;
}

/** 命令身份（回执字段的服务端可信来源）。 */
export interface PlanningStartCommandIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly scope: CommandScope;
  readonly requestDigest: string;
  readonly issuedAt: string;
}

/** 事务内提交上下文（由命令服务传入的装配事实，不来自请求）。 */
export interface PlanningStartSubmitContext {
  /** 是否装配了派发唤醒端口（决定 Run 排队原因的可查询形态）。 */
  readonly schedulerAssembled: boolean;
}

/** 事务内提交使用的命令信封最小面（scope/payload；操作固定 planning.start）。 */
export interface PlanningStartEnvelopeFace {
  readonly scope: { readonly kind: 'project'; readonly projectId: string };
  readonly expectedRevision: number;
  readonly payload: { readonly request: ValidatedPlanningRequest; readonly budget: Record<string, unknown> };
}

/**
 * 一次性规划启动端口：preparePlanningStart 在写事务之外完成请求校验与预算
 * 深校验（无仓库/模型 I/O）；submitPlanningStart 在调用方的同一 BEGIN
 * IMMEDIATE 短写事务内重核全部前置条件并原子提交 Batch/Run/planning Task/
 * 上下文/预算修订行/派发意图/事件与 accepted v7 回执。实现者：
 * createPlanningStartService。
 */
export interface PlanningStartPort {
  preparePlanningStart(
    projectId: string,
    payload: { readonly request: ValidatedPlanningRequest; readonly budget: Record<string, unknown> },
  ): Promise<PreparedPlanningStart>;
  submitPlanningStart(
    identity: PlanningStartCommandIdentity,
    envelope: PlanningStartEnvelopeFace,
    transaction: CommandTransaction,
    prepared: PreparedPlanningStart,
    context: PlanningStartSubmitContext,
  ): CommandReceipt;
}
