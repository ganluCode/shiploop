/**
 * P03-2 / F-002 绑定当前 planDigest 的计划批准/拒绝决策应用用例
 * （application 层；在调用方的同一 BEGIN IMMEDIATE 写事务内执行，无任何
 * 事务外 I/O）。
 *
 * 设计依据：p03-plan-approval PRD（版本 0.3）FR-1「批准绑定 planDigest；拒绝
 * 不启动执行；批准不是启动授权；复用 P03-1 创建时已复制的完整默认策略，
 * 不再次创建 Task 或在批准时追溯替换策略」、docs/p03-2-plan-approval-contract.md
 * （本模块契约文档）与 core-design/02 §10（批准绑定摘要，不管理历史计划版本）、
 * core-design/11 §7（approvals 决策记录表）。
 *
 * 不变量：
 * - 决策绑定**提交时当前计划身份**：请求携带的摘要与库内当前摘要不一致
 *   （失效摘要，含库内摘要为空）即固化 rejected（fail-closed），不提供执行
 *   依据；实质修订改变摘要后旧摘要决策自然成为历史记录，本用例不改写旧决策
 *   行（查询按摘要区分当前/历史决定）。P03-2 / F-003 起决策同时绑定提交时
 *   当前适用检查政策身份摘要（checkPolicyDigest；决策身份 = planDigest +
 *   检查政策摘要复合，同一写事务内从全局+项目当前配置合并计算）；
 * - actor 唯一权威来源是可信主体装配（TrustedPrincipal.principalId）：请求
 *   payload 不能伪造身份（decisionActor/principalId/approval 等字段在信封
 *   校验层即未知键拒绝），记录的 decisionActor 恒为提交主体 principalId；
 * - 批准只确认现有计划：保留全部既有 Task ID、依赖边、完整策略副本与来源，
 *   绝不重建 Task、不按当前默认配置覆盖副本（写入面只有 approvals 插入与
 *   Feature plan_status/revision 单语句条件 UPDATE）；
 * - 正常批准使当前计划可作为后续**显式执行授权**的依据（planStatus=approved），
 *   拒绝不提供该依据（planStatus 落 draft）；两种决策都不创建 Batch/Run/
 *   Attempt、不调用 Runtime、不启动 Git 或检查进程（P03-2 存储无执行实体表，
 *   start/claim 属后续阶段且必须另行显式授权）；
 * - fail-closed 拒绝矩阵（全部在任何业务写入之前固化 rejected 回执或抛出，
 *   零业务写入）：缺审批能力（forbidden 抛出）、跨项目请求（ownership →
 *   forbidden 抛出，不泄漏存在性）、目标缺失（not_found 抛出）、失效
 *   planDigest（plan_digest_mismatch）、空任务不可执行计划（no_tasks）、
 *   重复竞争决策（approval_already_decided——同一主体同一摘要至多一条决策，
 *   两个竞争决定最多一个生效）、陈旧 revision（conflict 携带 expected/actual）；
 * - 决策记录、Feature plan_status/revision、脱敏事件与回执在**同一短写事务**
 *   内提交：写入故障（触发器注入/约束异常）整组回滚，不留下半条有效批准；
 *   事件 payload 恒定（{approved:true}/{rejected:true}），不携带计划正文/
 *   决策人身份/原因/执行语义；回执结果有界（Feature 公共记录 + 决策事实），
 *   不携带策略副本正文、不声称已启动执行。
 */
import { randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import {
  PublicError,
  createCompletedReceipt,
  createRejectedReceipt,
  mapStorageError,
} from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import { isStorageError } from '../ports/errors.js';
import {
  FEATURE_PLAN_APPROVED_EVENT_TYPE,
  FEATURE_PLAN_REJECTED_EVENT_TYPE,
} from '../ports/plan-store.js';
import type { FeaturePlanDecision, FeaturePlanStatus } from '../ports/plan-store.js';
import { toPublicFeatureRecord, toPublicPlanApprovalRecord } from '../ports/queries.js';
import { resolveCurrentCheckPolicyDigest } from './plan-approval-verification.js';

/** 计划批准/拒绝决策命令操作名（与 COMMAND_OPERATIONS 白名单同一冻结名）。 */
export const FEATURE_PLAN_DECIDE_OPERATION = 'feature.plan.decide' as const;

/**
 * F-002（P03-2）纯规则（p03-plan-approval PRD FR-1 与设计 02 §10/11 §7 的可核对
 * 冻结面）：计划决策的影响面。只插入一条绑定当前 planDigest 的决策记录并更新
 * Feature 自身 plan_status/revision；不改计划内容/摘要、不触碰 Task/依赖/策略
 * 副本与来源、不传播父子实体、不创建任何执行实体、不启动 Runtime/Git/检查
 * 进程；批准只使当前计划成为后续**显式执行授权**的依据（planStatus=approved），
 * 拒绝不提供该依据（planStatus 落 draft）；同主体同摘要至多一条决策（重复
 * 竞争决策 fail-closed，两个竞争决定最多一个生效）。与实质计划修订
 * （PLAN_REVISE_IMPACT）、Task 策略编辑（TASK_STRATEGY_EDIT_IMPACT）是可区分
 * 的契约。
 */
export const PLAN_DECIDE_IMPACT = Object.freeze({
  recordsDecisionBoundToCurrentPlanDigest: true,
  /**
   * P03-2 / F-003：决策同时绑定提交时当前适用检查政策身份（内容摘要，同一
   * 写事务内从全局+项目当前配置合并计算）；决策身份 = planDigest +
   * checkPolicyDigest 复合。
   */
  bindsCurrentCheckPolicyIdentity: true,
  changesFeaturePlanStatus: true,
  changesFeatureOwnRevision: true,
  preservesPlanDigest: true,
  preservesPlanContent: true,
  preservesTaskIdsDependenciesStrategyAndSources: true,
  rereadsDefaultRouting: false,
  makesPlanBasisForExplicitExecution: 'approve_only',
  propagatesToParentOrChild: false,
  createsExecutionEntities: false,
  startsRuntimeGitOrChecks: false,
  allowsAtMostOneDecisionPerDigest: true,
});

/**
 * 决策 → 记录状态与 Feature plan_status 的纯映射（可独立测试）：
 * approve → 记录 approved、planStatus=approved（后续显式执行授权的依据）；
 * reject → 记录 rejected、planStatus=draft（不提供执行依据；planStatus 枚举
 * 无 rejected 值，拒绝事实由决策记录承载，查询不把拒绝显示为已批准）。
 */
export function decideFeaturePlanOutcome(decision: FeaturePlanDecision): {
  readonly recordStatus: 'approved' | 'rejected';
  readonly planStatusAfter: FeaturePlanStatus;
} {
  if (decision === 'approve') {
    return { recordStatus: 'approved', planStatusAfter: 'approved' };
  }
  return { recordStatus: 'rejected', planStatusAfter: 'draft' };
}

export type FeaturePlanDecideEnvelope = Extract<
  import('../ports/commands.js').ValidatedCommandEnvelope,
  { operation: typeof FEATURE_PLAN_DECIDE_OPERATION }
>;

/** 决策提交身份（回执公共字段；由命令服务从信封与服务端时钟组装）。 */
export interface FeaturePlanDecideIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof FEATURE_PLAN_DECIDE_OPERATION;
  readonly scope: FeaturePlanDecideEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/**
 * 提交计划批准/拒绝决策：在调用方的同一写事务内完成全部重核与原子提交，
 * 返回持久化回执（completed/rejected）。除 saveReceipt 外的任何失败都以异常
 * 抛出（整组回滚，零回执）；确定性业务拒绝（失效摘要/空任务/重复决策/聚合
 * CAS）在任何业务写入之前固化 rejected。
 */
export function submitFeaturePlanDecide(
  identity: FeaturePlanDecideIdentity,
  envelope: FeaturePlanDecideEnvelope,
  transaction: CommandTransaction,
  nowUtcMs: number,
): CommandReceipt {
  const operation = FEATURE_PLAN_DECIDE_OPERATION;
  const projectId = envelope.scope.projectId;
  const featureId = envelope.payload.featureId;

  // 1) 父级项目把关：缺失/不可见统一 forbidden（不泄漏存在性；抛出）。
  try {
    transaction.getProject(projectId);
  } catch (error) {
    mapProjectLookupError(error, operation);
  }

  // 2) 计划快照：目标缺失 not_found、跨项目 forbidden（抛出，零写入）。
  const snapshot = transaction.getFeaturePlan(projectId, featureId);
  const feature = snapshot.feature;

  const rejected = (details: Record<string, unknown>): CommandReceipt => {
    const receipt = createRejectedReceipt({
      ...identity,
      error: new PublicError('conflict', operation, undefined, { details }),
    });
    transaction.saveReceipt(receipt);
    return receipt;
  };

  // 3) 摘要绑定重核（同一写事务重核）：提交摘要必须等于库内当前 planDigest
  //    （失效摘要含库内摘要为空 → fail-closed；不泄漏库内摘要正文）。
  if (feature.planDigest !== envelope.payload.planDigest) {
    return rejected({ reason: 'plan_digest_mismatch', entityType: 'feature' });
  }

  // 3b) P03-2 / F-003：当前适用检查政策身份（同一写事务内从全局+项目当前
  //     配置合并计算的政策内容摘要）随决策绑定——不依赖可变配置路径、
  //     通用配置 revision 或 labels。
  const globalSettings = transaction.getGlobalSettingsOrNull();
  const projectSettings = transaction.getProjectSettingsOrNull(projectId);
  const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
    globalSettings === null
      ? null
      : { scopeRevision: globalSettings.revision, payload: globalSettings.payload },
    projectSettings === null
      ? null
      : { scopeRevision: projectSettings.revision, payload: projectSettings.payload },
  );

  // 4) 空任务不可执行计划：零 Task 草稿不可作为执行依据被批准或拒绝
  //    （与 FEATURE_NOT_EXECUTABLE_REASONS 的 no_tasks 同一词汇）。
  if (snapshot.tasks.length === 0) {
    return rejected({ reason: 'no_tasks', entityType: 'feature' });
  }

  // 5) 重复竞争决策：同主体同身份（planDigest + 检查政策摘要复合）至多一条
  //    决策（两个竞争决定最多一个生效；事务内重核 + DDL 唯一索引兜底，
  //    翻转任何既有决策都必须先实质修订；检查政策变化后同一 planDigest 可
  //    重新批准当前身份，旧行作为历史证据保留）。
  if (
    transaction.findPlanApproval(projectId, featureId, envelope.payload.planDigest, checkPolicyDigest) !==
    undefined
  ) {
    return rejected({ reason: 'approval_already_decided', entityType: 'feature' });
  }

  // 6) Feature 聚合 CAS：写入之前的确定性业务拒绝，固化 rejected。
  if (feature.revision !== envelope.expectedRevision) {
    return rejected({
      reason: 'conflict',
      expectedRevision: envelope.expectedRevision,
      actualRevision: feature.revision,
      entityType: 'feature',
    });
  }

  // 7) 决策映射（纯规则）：approve → approved/approved；reject → rejected/draft。
  const outcome = decideFeaturePlanOutcome(envelope.payload.decision);

  // 8) 原子提交（同一短写事务）：Feature plan_status/revision 单语句条件
  //    UPDATE 先行（CAS 裁决竞争窗口）→ 决策记录插入 → 脱敏事件 → 回执。
  //    任何写入异常整组回滚，不留下半条有效批准。
  const decidedAt = nowUtcMs;
  let updatedFeature;
  try {
    updatedFeature = transaction.updateFeaturePlanStatus({
      projectId,
      featureId,
      planStatus: outcome.planStatusAfter,
      expectedRevision: envelope.expectedRevision,
    });
  } catch (error) {
    if (isStorageError(error, 'conflict')) {
      const receipt = createRejectedReceipt({
        ...identity,
        error: mapStorageError(error, { operation }),
      });
      transaction.saveReceipt(receipt);
      return receipt;
    }
    if (isStorageError(error)) {
      throw mapStorageError(error, { operation });
    }
    throw error;
  }
  const approval = transaction.insertPlanApproval({
    projectId,
    subjectType: 'feature_plan',
    subjectId: featureId,
    subjectDigest: feature.planDigest,
    checkPolicyDigest,
    status: outcome.recordStatus,
    decisionActor: identity.principalId,
    ...(envelope.payload.reason === null ? {} : { reason: envelope.payload.reason }),
    decidedAtUtcMs: decidedAt,
  });

  // 9) 同事务脱敏事件（恒定 payload；批准/拒绝两类事件可区分，聚合为目标
  //    Feature 自身，aggregateRevision=决策后聚合 revision）。
  transaction.appendPlanEvent({
    projectId,
    eventType:
      outcome.recordStatus === 'approved'
        ? FEATURE_PLAN_APPROVED_EVENT_TYPE
        : FEATURE_PLAN_REJECTED_EVENT_TYPE,
    aggregateType: 'feature',
    aggregateId: updatedFeature.id,
    aggregateRevision: updatedFeature.revision,
    payload: outcome.recordStatus === 'approved' ? { approved: true } : { rejected: true },
  });

  // 10) completed 回执：有界结果携带决策后的 Feature 公共记录与决策事实；
  //     不携带策略副本正文、决策人身份之外的主体信息，不声称已启动执行。
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      feature: toPublicFeatureRecord(updatedFeature),
      decision: envelope.payload.decision,
      approval: {
        ...toPublicPlanApprovalRecord(approval),
        current: true,
      },
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
