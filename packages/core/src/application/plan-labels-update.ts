/**
 * P03-1 / F-007 纯标签 CAS 编辑应用用例（application 层；在调用方的同一
 * BEGIN IMMEDIATE 写事务内执行，无任何事务外 I/O）。
 *
 * 设计依据：docs/p03-1-plan-import-contract.md §6.7（标签编辑命令定案）、
 * core-design/02 §10 标签纪律（「更新标签是元数据编辑，须按实体 revision 做
 * CAS 并记录变更，但不因单纯改标签使计划审批、Task 通过结果或活动 Run 失效」）
 * 与 core-design/08（updateLabels 不改变状态、依赖、验收或已启动 Run）。
 *
 * 不变量：
 * - 纯标签编辑只更新目标实体（Phase/Feature/Task）的 labels 与自身 revision
 *   （连带 updated_at）；计划内容、Task 策略副本、acceptance、引用、依赖边、
 *   planDigest 与 planStatus 一律不变；标签不向父子实体传播；
 * - expectedRevision 唯一权威来源是命令信封顶层（目标实体自身 revision）：
 *   旧 revision 拒绝（固化 rejected 回执，conflict），同 revision 竞争编辑经
 *   单语句条件 UPDATE 裁决仅一个生效；同 commandId 重放返回原回执且不再次
 *   增加 revision/事件（P02 §5.5 幂等机制）；
 * - 冲突类业务拒绝在任何业务写入之前固化 rejected；归属/结构类失败（跨项目
 *   目标、非法标签、混入非标签字段）以公开错误抛出（forbidden/invalid_input），
 *   零回执零业务写入；
 * - 编辑成功在同一事务内追加脱敏事件（phase.labels.updated /
 *   feature.labels.updated / task.labels.updated，payload 恒 {labelsUpdated:true}）；
 * - 本用例不创建 Batch/Run/Attempt、不写批准、不实现计划实质修订（F-008）；
 *   标签编辑不使既有计划批准（approved 语义）或活动输入（Batch/Run 的固定 ID
 *   集与摘要快照）失效——见下方纯规则 PLAN_LABELS_EDIT_IMPACT（P03-1 无审批/
 *   Run 创建入口，该规则以纯规则 + 隔离测试装配验证，不为测试前提增加生产入口）。
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
import { EXECUTION_RUN_LABELS_UPDATED_EVENT_TYPE } from '../ports/execution-store.js';
import {
  FEATURE_LABELS_UPDATED_EVENT_TYPE,
  PHASE_LABELS_UPDATED_EVENT_TYPE,
  TASK_LABELS_UPDATED_EVENT_TYPE,
} from '../ports/plan-store.js';
import type { PlanEntityType } from '../ports/plan-store.js';

/** 标签编辑命令操作名（与 COMMAND_OPERATIONS 白名单同一冻结名）。 */
export const PLAN_LABELS_UPDATE_OPERATION = 'plan.labels.update' as const;

/**
 * F-007 纯规则（core-design/02 标签元数据纪律的可核对冻结面）：纯标签 CAS
 * 编辑的影响面。标签不参与 planDigest（feature-plan 的摘要规范化白名单明确
 * 不含 labels），因此纯标签编辑不改变计划业务身份——不重算摘要、不改批准
 * 状态、不使既有计划批准（approved 语义）、Task 通过结果或活动输入
 * （Batch/Run 的固定 ID 集与摘要快照）失效，也不向父子实体传播。
 * 实质计划编辑（F-008）的影响面随其功能另行冻结（契约 §6.2 已定案其更新
 * planDigest 并使旧摘要的批准不可继续生效），两者是可区分的契约。
 */
export const PLAN_LABELS_EDIT_IMPACT = Object.freeze({
  changesPlanDigest: false,
  changesPlanStatus: false,
  changesPlanContent: false,
  changesTaskStrategy: false,
  invalidatesPlanApproval: false,
  invalidatesTaskResults: false,
  invalidatesActiveInputs: false,
  propagatesToParentOrChild: false,
});

/** 标签编辑事件类型（按目标实体冻结；payload 恒 {labelsUpdated:true}）。 */
const LABELS_UPDATED_EVENT_TYPE_BY_ENTITY: Readonly<Record<Exclude<PlanEntityType, 'run'>, string>> = Object.freeze({
  phase: PHASE_LABELS_UPDATED_EVENT_TYPE,
  feature: FEATURE_LABELS_UPDATED_EVENT_TYPE,
  task: TASK_LABELS_UPDATED_EVENT_TYPE,
});

export type PlanLabelsUpdateEnvelope = Extract<
  import('../ports/commands.js').ValidatedCommandEnvelope,
  { operation: typeof PLAN_LABELS_UPDATE_OPERATION }
>;

/** 标签编辑提交身份（回执公共字段；由命令服务从信封与服务端时钟组装）。 */
export interface PlanLabelsUpdateIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof PLAN_LABELS_UPDATE_OPERATION;
  readonly scope: PlanLabelsUpdateEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/**
 * 提交纯标签 CAS 编辑：在调用方的同一写事务内完成归属/标签/CAS 更新、脱敏
 * 事件与回执。除 saveReceipt 外的任何失败都以异常抛出（整组回滚，零回执）；
 * CAS 不匹配在任何业务写入之前固化 rejected。
 */
export function submitPlanLabelsUpdate(
  identity: PlanLabelsUpdateIdentity,
  envelope: PlanLabelsUpdateEnvelope,
  transaction: CommandTransaction,
): CommandReceipt {
  const operation = PLAN_LABELS_UPDATE_OPERATION;
  const projectId = envelope.scope.projectId;
  const entityType = envelope.payload.entityType;

  // 1) 父级项目把关：缺失/不可见统一 forbidden（不泄漏存在性；抛出）。
  try {
    transaction.getProject(projectId);
  } catch (error) {
    mapProjectLookupError(error, operation);
  }

  // 2) 纯标签 CAS 更新：单语句条件 UPDATE 只触达 labels/revision/updated_at；
  //    归属失败（跨项目目标）/缺失抛公开错误（零写入）；CAS 不匹配抛 conflict
  //    StorageError（携带 expected/actual），在下面固化 rejected。
  let updated;
  try {
    updated = transaction.updatePlanEntityLabels({
      entityType,
      projectId,
      id: envelope.payload.id,
      labels: envelope.payload.labels,
      expectedRevision: envelope.expectedRevision,
    });
  } catch (error) {
    if (isStorageError(error, 'conflict')) {
      // 旧 revision 竞争失败：固化稳定 rejected 回执（与 F-005 导入 CAS 同形）。
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

  // 3) 同事务脱敏事件（恒定 payload；不携带标签正文/批准语义）。
  if (entityType === 'run') {
    transaction.appendExecutionEvent({
      projectId,
      eventType: EXECUTION_RUN_LABELS_UPDATED_EVENT_TYPE,
      aggregateType: 'run',
      aggregateId: updated.id,
      aggregateRevision: updated.revision,
      payload: { labelsUpdated: true },
    });
  } else {
    transaction.appendPlanEvent({
      projectId,
      eventType: LABELS_UPDATED_EVENT_TYPE_BY_ENTITY[entityType],
      aggregateType: entityType,
      aggregateId: updated.id,
      aggregateRevision: updated.revision,
      payload: { labelsUpdated: true },
    });
  }

  // 4) completed 回执：有界结果只携带本次标签编辑事实（不回显计划正文/策略
  //    副本，不声称批准、可执行或执行结果）。
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      entityType,
      id: updated.id,
      labels: [...updated.labels],
      revision: updated.revision,
      updatedAt: new Date(updated.updatedAtUtcMs).toISOString(),
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
