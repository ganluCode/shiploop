/**
 * P03-3 / F-009 批次预算显式修订应用用例（application 层；在调用方的同一
 * BEGIN IMMEDIATE 写事务内执行，无任何事务外 I/O）。
 *
 * 设计依据：core-design/04 §6.1（截止时间是持久绝对时间，暂停不自动延长；
 * 需要延期由用户显式审批记录新预算版本；CAS 上限更新失败不派发；预算耗尽
 * 需人决定继续、增额或结束）、core-design/08 §2（reviseBatchBudget：累计预算
 * 不随重启/子 Run 清零，增额需明确授权；模型不能调用新建 Batch 或增额命令来
 * 绕过授权预算）、docs/p03-3-budget-revision-contract.md（本模块契约文档）。
 *
 * 不变量：
 * - 命令面 `execution.budget.revise`（capability `execution.budget.revise`，
 *   独立于 execution.start 的授权面：增额/延期是一次新的明确用户授权）；
 *   更新类命令：信封 expectedRevision 是目标 Batch 当前 budget_revision 的
 *   CAS 期望（唯一权威来源，payload 内出现即未知键）；payload 冻结为
 *   { batchId, budget, reason }——batchId 定位目标（归属与 CAS 在事务内重核），
 *   budget 为修订后的完整预算提案（深校验复用 ports/execution-budget 权威
 *   校验器，deadline 已到达即拒绝），reason 非空有界（审计）；
 * - 批准主体是服务端可信身份绑定（approvedBy=principalId；模型提出的理由或
 *   客户端自声明批准不授予权限，payload 携带身份字段即未知键拒绝）；
 * - 仅增额或延期：evaluateBatchBudgetRevision 单调判定（计数/ deadline/Run 层
 *   上限不回退；可选资源总额不可中途引入或移除；携带累计用量的降额防御），
 *   违规固化 rejected（revision_not_increased/limit_below_used）且零业务写入；
 * - 终态 Batch 不接受修订（batch_not_active：授权已关闭，新工作需新授权；
 *   paused/interrupted 是活动集，可增额——暂停不是绕过终态的通道）；
 * - 有效修订在同一短事务内原子提交：当前预算（budget_snapshot/
 *   budget_revision/deadline_at）+ 不可变修订行（version+1，主体/时间/理由/
 *   预算快照）+ execution.budget.revised 脱敏事件（恒 {revised:true}）+
 *   completed 回执（携带修订前后值）；任一步失败整组回滚（无部分更新）；
 * - 保留此前授权预算及 Run/Task/输入快照：累计计数（runs_created/
 *   attempts_created/runtime_starts/no_progress_runs）不清零，Run 派发冻结上限
 *   与身份/范围/配置快照列不触碰（迁移 v9 触发器保护）；
 * - 仅增额不自动启动或恢复 Run：本用例不创建 Run、不递增 runtime_starts、
 *   不写派发事件、不唤醒任何调度器（持久状态是权威）；
 * - 幂等由命令面承担：同 commandId 完整重放返回原回执（不产生第二条修订或
 *   事件）；复用 commandId 异参由 requestDigest 冲突拒绝；
 * - Task 代码尝试上限（maxCodeAttempts）不在本命令面：显式调整只经
 *   task.strategy.update 策略 CAS 通道（同一授权与审计纪律）；更新默认配置
 *   不追溯既有 Task 副本（F-001 捕获语义），换 Run 不清 Task 累计计数（F-006）。
 */
import { randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import { createCompletedReceipt, createRejectedReceipt, mapStorageError, PublicError } from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import type { ExecutionBudgetSnapshot } from '../ports/execution-budget.js';
import { evaluateBatchBudgetRevision, validateExecutionBudgetProposal } from '../ports/execution-budget.js';
import { EXECUTION_BUDGET_REVISED_EVENT_TYPE, isExecutionTerminalStatus } from '../ports/execution-store.js';

/** 批次预算显式修订命令操作名（与 COMMAND_OPERATIONS 白名单同一冻结名）。 */
export const EXECUTION_BUDGET_REVISE_OPERATION = 'execution.budget.revise' as const;

export type ExecutionBudgetReviseEnvelope = Extract<
  import('../ports/commands.js').ValidatedCommandEnvelope,
  { operation: typeof EXECUTION_BUDGET_REVISE_OPERATION }
>;

/** 预算修订提交身份（回执公共字段；由命令服务从信封与服务端时钟组装）。 */
export interface ExecutionBudgetReviseIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof EXECUTION_BUDGET_REVISE_OPERATION;
  readonly scope: ExecutionBudgetReviseEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/** 预算语义校验错误 → 公开错误（字段定位改写为 payload.budget.*，不回显输入正文）。 */
function budgetValidationError(error: StorageError): PublicError {
  const mapped = mapStorageError(error, { operation: EXECUTION_BUDGET_REVISE_OPERATION });
  const field = mapped.details?.field;
  if (typeof field !== 'string') {
    return mapped;
  }
  const details = { ...(mapped.details ?? {}) };
  details.field = field.startsWith('budget') ? `payload.${field}` : `payload.budget.${field}`;
  return new PublicError(mapped.code, EXECUTION_BUDGET_REVISE_OPERATION, undefined, { details });
}

/**
 * 提交批次预算显式修订：在调用方的同一写事务内完成项目把关、预算深校验
 * （deadline 已到达即拒绝）、修订原语（CAS/活动集/单调判定 + 原子写入）、
 * 脱敏事件与 completed 回执。非法输入在任何 SQL 之前拒绝（抛出，零回执）；
 * CAS/终态/单调冲突在任何业务写入之前固化 rejected。
 */
export function submitExecutionBudgetRevise(
  identity: ExecutionBudgetReviseIdentity,
  envelope: ExecutionBudgetReviseEnvelope,
  transaction: CommandTransaction,
  now: number,
): CommandReceipt {
  const operation = EXECUTION_BUDGET_REVISE_OPERATION;
  const projectId = envelope.scope.projectId;

  // 1) 父级项目把关：缺失/不可见统一 forbidden（不泄漏存在性；抛出）。
  try {
    transaction.getProject(projectId);
  } catch (error) {
    mapProjectLookupError(error, operation);
  }

  // 2) 预算深校验（复用 ports/execution-budget 权威提案校验器；deadline 已
  //    到达/过期即拒绝——延期必须给出未过期的新绝对时间）。失败抛
  //    invalid_input（零写入零回执）。
  let budget: ExecutionBudgetSnapshot;
  try {
    const proposal = validateExecutionBudgetProposal(envelope.payload.budget, {
      operation,
      entity: { type: 'execution_batch', projectId, id: envelope.payload.batchId },
    }, { referenceNowUtcMs: now });
    budget = { schemaVersion: 1, batch: proposal.batch, run: proposal.run };
  } catch (error) {
    if (error instanceof StorageError) {
      throw budgetValidationError(error);
    }
    throw error;
  }

  // 3) 目标 Batch 读取：缺失 not_found、跨项目 ownership（抛出，零写入零回执）。
  let batch;
  try {
    batch = transaction.getExecutionBatch(projectId, envelope.payload.batchId);
  } catch (error) {
    if (isStorageError(error)) {
      throw mapStorageError(error, { operation });
    }
    throw error;
  }

  // 4) 写入之前的确定性业务拒绝（同一事务内的预检读；固化 rejected，零业务
  //    写入）：CAS（expectedRevision=当前 budget_revision）、活动集（终态
  //    Batch 授权已关闭）与仅增额或延期单调判定（携带累计用量防御降额）。
  const rejected = (details: Record<string, unknown>): CommandReceipt => {
    const receipt = createRejectedReceipt({
      ...identity,
      error: new PublicError('conflict', operation, undefined, { details }),
    });
    transaction.saveReceipt(receipt);
    return receipt;
  };
  if (batch.budgetRevision !== envelope.expectedRevision) {
    return rejected({
      reason: 'budget_revision_stale',
      expectedRevision: envelope.expectedRevision,
      actualRevision: batch.budgetRevision,
      entityType: 'execution_batch',
    });
  }
  if (isExecutionTerminalStatus(batch.status)) {
    return rejected({ reason: 'batch_not_active', entityType: 'execution_batch' });
  }
  const monotonic = evaluateBatchBudgetRevision({
    current: batch.budgetSnapshot,
    proposed: budget,
    usage: {
      runsCreated: batch.runsCreated,
      attemptsCreated: batch.attemptsCreated,
      runtimeStarts: batch.runtimeStarts,
      noProgressRuns: batch.noProgressRuns,
    },
  });
  if (!monotonic.allowed) {
    const primary = monotonic.violations[0];
    return rejected({
      reason: primary.reason === 'limit_below_used' ? 'limit_below_used' : 'revision_not_increased',
      entityType: 'execution_batch',
    });
  }

  // 5) 修订原语（同事务原子写入：当前预算 CAS UPDATE + 不可变修订行）。预检
  //    与写入在同一 BEGIN IMMEDIATE 事务内（无竞争窗口）；原语仍在写入前重核
  //    全部守卫（防御纵深）。此处不捕获 conflict：预检之后的任何失败都发生在
  //    写入阶段（写后异常只能回滚，不能吞成 rejected；客户端可换 commandId
  //    重试）。
  const result = transaction.reviseBatchBudget({
    projectId,
    batchId: envelope.payload.batchId,
    expectedBudgetRevision: envelope.expectedRevision,
    budgetSnapshot: budget,
    approvedBy: identity.principalId,
    reason: envelope.payload.reason,
  });

  // 4) 同事务脱敏事件（恒定 payload；聚合为目标 Batch 自身，不携带预算数值/
  //    理由正文/批准主体/启动语义——修订不自动启动或恢复 Run）。
  transaction.appendExecutionEvent({
    projectId,
    eventType: EXECUTION_BUDGET_REVISED_EVENT_TYPE,
    aggregateType: 'execution_batch',
    aggregateId: result.batch.id,
    aggregateRevision: result.batch.revision,
    payload: { revised: true },
  });

  // 5) completed 回执：结果携带修订前后值、批准主体、理由与版本（审计核对
  //    面；预算数值是已授权上限，不是秘密）；不声称已启动、恢复或派发。
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      schemaVersion: 1,
      batchId: result.batch.id,
      budgetRevision: result.revision.version,
      approvedBy: identity.principalId,
      reason: envelope.payload.reason,
      revisedAt: identity.completedAt,
      previous: {
        version: result.previousBudgetRevision,
        budget: result.previousBudgetSnapshot,
        deadlineAtUtcMs: result.previousDeadlineAtUtcMs,
      },
      revised: {
        version: result.revision.version,
        budget: result.revision.budgetSnapshot,
        deadlineAtUtcMs: result.revision.deadlineAtUtcMs,
      },
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
