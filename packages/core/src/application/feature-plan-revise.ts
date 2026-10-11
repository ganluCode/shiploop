/**
 * P03-1 / F-008 未执行草稿的实质计划修订应用用例（application 层；在调用方
 * 的同一 BEGIN IMMEDIATE 写事务内执行，无任何事务外 I/O）。
 *
 * 设计依据：docs/p03-1-plan-import-contract.md §6.2（更新条款：实质修订在
 * Feature 聚合的同一写事务内整体替换计划成员与边，一次 CAS 一次递增）与
 * §6.8（F-008 定案）、core-design/02 §10（标签/元数据纪律与实质修订边界）、
 * core-design/03 §4（CAS revision 纪律）、core-design/12（活动执行不越过
 * 保护条件）。
 *
 * 不变量：
 * - 草稿可编辑性与活动执行输入保护条件在同一写事务内重核：Feature 业务
 *   状态非 draft（未执行草稿语义）即固化 rejected；活动执行输入探测
 *   （queued/running/paused/停止未知等活动依据）返回活动即固化 rejected；
 *   探测失败 fail-closed——异常传播整组回滚，绝不默认为「无活动」；
 *   未来 start/claim 必须遵守同一写事务与聚合 CAS 契约（不能只在事务外查
 *   一次或用进程内布尔锁），两者靠 BEGIN IMMEDIATE 串行化与 Feature 聚合
 *   revision CAS 裁决竞争；
 * - expectedRevision 唯一权威来源是命令信封顶层（Feature 聚合 revision）：
 *   旧 revision 固化 rejected 回执（conflict，携带 expected/actual）；
 *   同 revision 竞争修订/标签编辑经单语句条件 UPDATE 裁决仅一个生效
 *   （与 F-007 共用同一 Feature 聚合 CAS 空间）；
 * - 成员整体替换：既有 Task 按稳定 ID 保留身份与既有策略副本（不因当前
 *   默认配置或 complexity 编辑自动更换 executionConfig，替换原语在存储层
 *   强制保留），仅新 Task 按创建策略规则（F-003 selectTaskStrategy）从本
 *   事务读取的当前配置复制完整策略与来源；Task 策略编辑、重新应用默认与
 *   执行输入快照属 P03-2，不在本用例；
 * - 实质变化（planDigest 改变）使旧摘要批准不可继续生效：planStatus 回到
 *   draft（批准绑定摘要，见 decidePlanApprovalValidity 纯规则）；纯标签
 *   变化不参与摘要，经由修订载荷的纯标签编辑不使批准失效；导入草稿修订后
 *   仍是草稿，不自动批准或启动执行；完整 Approval 记录/决策流程属 P03-2；
 * - 引用重核与导入同一契约语义（缺失 not_found、跨项目 forbidden 抛出；
 *   非 ready/内容哈希不匹配固化 rejected）；计划深校验复用 F-001 纯校验器
 *   并以库内既有任务身份为 externalTasks 上下文；
 * - 本用例不创建 Batch/Run/Attempt、不写批准、不虚构执行结果；修订成功在
 *   同一事务内追加 feature.plan.revised 脱敏事件与 completed 回执（结果
 *   有界，不携带策略副本正文）；P03-1 存储无 Batch/Run/Attempt 表，生产
 *   装配默认探测即「无执行实体表」的能力边界宣告，不是查询失败兜底。
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
import { isStorageError, StorageError } from '../ports/errors.js';
import { validateFeaturePlanInput } from '../ports/feature-plan.js';
import type { ValidatedFeaturePlan } from '../ports/feature-plan.js';
import {
  FEATURE_PLAN_REVISED_EVENT_TYPE,
  FEATURE_PLAN_STATUSES,
} from '../ports/plan-store.js';
import type { FeaturePlanStatus, FeaturePlanSnapshot } from '../ports/plan-store.js';
import { toPublicFeatureRecord } from '../ports/queries.js';
import { selectTaskStrategy } from './task-strategy-selection.js';
import type { TaskStrategySelection } from './task-strategy-selection.js';

/** 实质计划修订命令操作名（与 COMMAND_OPERATIONS 白名单同一冻结名）。 */
export const FEATURE_PLAN_REVISE_OPERATION = 'feature.plan.revise' as const;

/**
 * F-008 纯规则（core-design/02 §10 与契约 §6.8 的可核对冻结面）：实质修订
 * 的影响面。整体替换计划成员与依赖边；既有 Task 保留稳定身份与既有策略
 * 副本，仅新 Task 走创建策略选择；planDigest 按新计划重算，实质变化使旧
 * 摘要批准不可继续生效；草稿修订后仍是草稿（不自动批准/启动执行）；
 * 活动执行输入保护在同一写事务内 fail-closed 重核。与 F-007 纯标签编辑
 * （PLAN_LABELS_EDIT_IMPACT）是可区分的契约。
 */
export const PLAN_REVISE_IMPACT = Object.freeze({
  replacesPlanMembersWholesale: true,
  keepsExistingTaskStableIdentity: true,
  keepsExistingTaskStrategy: true,
  selectsStrategyForNewTasksOnly: true,
  updatesPlanDigest: true,
  invalidatesPriorDigestApprovals: true,
  keepsDraftPlansDraft: true,
  requiresSameTransactionActivityGuard: true,
  propagatesToParentOrChild: false,
  createsExecutionEntities: false,
});

/** 活动执行依据（ queued/running/paused/停止未知；活动执行输入保护的对象面）。 */
export const ACTIVE_EXECUTION_EVIDENCE_KINDS = [
  'queued',
  'running',
  'paused',
  'stop_unknown',
] as const;
export type ActiveExecutionEvidenceKind = (typeof ACTIVE_EXECUTION_EVIDENCE_KINDS)[number];

export type ActiveExecutionInputState =
  | { readonly active: false }
  | {
      readonly active: true;
      readonly evidence: { readonly kind: ActiveExecutionEvidenceKind };
    };

/**
 * 活动执行输入保护探测：在修订的同一写事务内调用（BEGIN IMMEDIATE 串行化，
 * 探测结果与后续写入之间不存在竞争窗口）。探测抛出即 fail-closed——整组
 * 回滚、不写回执，绝不把查询失败默认为「无活动」。未来 start/claim 引入
 * Batch/Run/Attempt 后必须以真实库内查询实现本探测并遵守同一事务与聚合
 * CAS 契约，不能只在事务外查一次或用进程内布尔锁。
 */
export type ActiveExecutionInputProbe = (target: {
  readonly projectId: string;
  readonly featureId: string;
}) => ActiveExecutionInputState;

/**
 * 生产默认探测：P03-1 存储无 Batch/Run/Attempt 表（迁移 v6 只有计划结构四表），
 * 不存在可活动的执行实体，故恒返回「无活动」。这是明确的能力边界宣告——
 * 不是「查询失败当作无活动」的兜底；执行实体表随执行链路（后续阶段）引入时
 * 必须替换为同事务真实查询（fail-closed），不得沿用本常量伪装已核验。
 */
export const NO_ACTIVE_EXECUTION_INPUTS_PROBE: ActiveExecutionInputProbe = () => ({
  active: false,
});

/**
 * 批准有效性纯规则（可独立测试；完整 Approval 记录/决策流程属 P03-2）：
 * 批准绑定 planDigest。实质变化（修订前后摘要不同，含清空/重建计划）使旧
 * 摘要批准不可继续生效——planStatus 回到 draft；摘要不变（标签不在摘要输入
 * 内，纯标签变化经由修订载荷不改变摘要）不失效，planStatus 保持。draft
 * 修订后仍是 draft；不自动批准（approved 只能经未来批准链路达成）。
 */
export function decidePlanApprovalValidity(input: {
  readonly planStatusBefore: FeaturePlanStatus;
  readonly planDigestBefore: string | null;
  readonly planDigestAfter: string | null;
}): {
  readonly substantiveChange: boolean;
  readonly planStatusAfter: FeaturePlanStatus;
  readonly priorDigestApprovalStillValid: boolean;
} {
  if (!(FEATURE_PLAN_STATUSES as readonly string[]).includes(input.planStatusBefore)) {
    throw new TypeError(`decidePlanApprovalValidity: 非法 planStatusBefore ${String(input.planStatusBefore)}`);
  }
  const substantiveChange = input.planDigestBefore !== input.planDigestAfter;
  if (!substantiveChange) {
    return {
      substantiveChange: false,
      planStatusAfter: input.planStatusBefore,
      priorDigestApprovalStillValid: input.planStatusBefore === 'approved',
    };
  }
  return {
    substantiveChange: true,
    planStatusAfter: 'draft',
    priorDigestApprovalStillValid: false,
  };
}

export type FeaturePlanReviseEnvelope = Extract<
  import('../ports/commands.js').ValidatedCommandEnvelope,
  { operation: typeof FEATURE_PLAN_REVISE_OPERATION }
>;

/** 修订提交身份（回执公共字段；由命令服务从信封与服务端时钟组装）。 */
export interface FeaturePlanReviseIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof FEATURE_PLAN_REVISE_OPERATION;
  readonly scope: FeaturePlanReviseEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/** 修订守卫（受控测试装配注入活动探测；缺省为生产无执行实体表边界宣告）。 */
export interface FeaturePlanReviseGuards {
  readonly activeExecutionInputs: ActiveExecutionInputProbe;
}

/** 计划校验错误 → 公开错误（字段定位改写为 payload.plan.*，不回显输入正文）。 */
function planValidationError(error: StorageError): PublicError {
  const mapped = mapStorageError(error, { operation: FEATURE_PLAN_REVISE_OPERATION });
  const field = mapped.details?.field;
  if (typeof field !== 'string') {
    return mapped;
  }
  const details = { ...(mapped.details ?? {}) };
  details.field = field === 'input' ? 'payload.plan' : `payload.plan.${field}`;
  return new PublicError(mapped.code, FEATURE_PLAN_REVISE_OPERATION, undefined, { details });
}

/** 从原始计划输入收集全部依赖目标（去重；仅用于库内解析，不做结构判定）。 */
function collectDependencyTargets(planInput: unknown): string[] {
  if (typeof planInput !== 'object' || planInput === null) {
    return [];
  }
  const tasks = (planInput as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) {
    return [];
  }
  const targets = new Set<string>();
  for (const task of tasks) {
    if (typeof task !== 'object' || task === null) {
      continue;
    }
    const dependsOn = (task as { dependsOn?: unknown }).dependsOn;
    if (!Array.isArray(dependsOn)) {
      continue;
    }
    for (const target of dependsOn) {
      if (typeof target === 'string' && target.length > 0) {
        targets.add(target.trim());
      }
    }
  }
  return [...targets];
}

/**
 * 提交实质计划修订：在调用方的同一写事务内完成全部重核与原子整体替换，
 * 返回持久化回执（completed/rejected）。除 saveReceipt 外的任何失败都以
 * 异常抛出（整组回滚，零回执）；冲突类业务拒绝（非 draft、活动执行输入
 * 保护、聚合 CAS、制品非可用/哈希不匹配）在任何业务写入之前固化 rejected。
 */
export function submitFeaturePlanRevise(
  identity: FeaturePlanReviseIdentity,
  envelope: FeaturePlanReviseEnvelope,
  transaction: CommandTransaction,
  guards: FeaturePlanReviseGuards = { activeExecutionInputs: NO_ACTIVE_EXECUTION_INPUTS_PROBE },
): CommandReceipt {
  const operation = FEATURE_PLAN_REVISE_OPERATION;
  const projectId = envelope.scope.projectId;
  const featureId = envelope.payload.featureId;

  // 1) 父级项目把关：缺失/不可见统一 forbidden（不泄漏存在性；抛出）。
  try {
    transaction.getProject(projectId);
  } catch (error) {
    mapProjectLookupError(error, operation);
  }

  // 2) 计划快照：目标缺失 not_found、跨项目 forbidden（抛出，零写入）。
  const snapshot: FeaturePlanSnapshot = transaction.getFeaturePlan(projectId, featureId);
  const feature = snapshot.feature;

  const rejected = (details: Record<string, unknown>): CommandReceipt => {
    const receipt = createRejectedReceipt({
      ...identity,
      error: new PublicError('conflict', operation, undefined, { details }),
    });
    transaction.saveReceipt(receipt);
    return receipt;
  };

  // 3) 草稿可编辑性（同一写事务重核）：只有未执行草稿可实质修订；执行生命
  //    周期内的 Feature（running/completed 等）不可被实质修改覆盖。
  if (feature.status !== 'draft') {
    // details 键受限控白名单（field/reason/expectedRevision/actualRevision/
    // entityType），执行状态值不进入回执。
    return rejected({ reason: 'feature_not_draft', entityType: 'feature' });
  }

  // 4) 活动执行输入保护（同一写事务重核；fail-closed）：queued/running/
  //    paused/停止未知等活动依据不能被实质修改覆盖；探测异常直接传播整组
  //    回滚（不写回执），绝不默认为「无活动」。
  const activity = guards.activeExecutionInputs({ projectId, featureId });
  if (activity.active) {
    // details 键受限控白名单；活动证据种类（queued/running/paused/停止未知）
    // 不进入回执（不泄漏执行细节）。
    return rejected({ reason: 'active_execution_inputs', entityType: 'feature' });
  }

  // 5) Feature 聚合 CAS：写入之前的确定性业务拒绝，固化 rejected。
  if (feature.revision !== envelope.expectedRevision) {
    return rejected({
      reason: 'conflict',
      expectedRevision: envelope.expectedRevision,
      actualRevision: feature.revision,
      entityType: 'feature',
    });
  }

  // 6) 计划深校验：复用 F-001 纯校验器 + 库内既有任务解析（externalTasks），
  //    精确区分「缺依赖」与「跨 Feature 依赖」；失败抛 invalid_input，零写入。
  const externalTaskIds = collectDependencyTargets(envelope.payload.plan);
  const externalTasks = transaction.getTaskFeatureLinks(externalTaskIds);
  let plan: ValidatedFeaturePlan;
  try {
    plan = validateFeaturePlanInput(envelope.payload.plan, {
      operation,
      externalTasks,
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw planValidationError(error);
    }
    throw error;
  }

  // 7) 批准有效性：批准绑定 planDigest；实质变化使旧摘要批准不可继续生效
  //    （planStatus 回到 draft），摘要不变保持。导入草稿修订后仍是草稿。
  const approval = decidePlanApprovalValidity({
    planStatusBefore: feature.planStatus,
    planDigestBefore: feature.planDigest,
    planDigestAfter: plan.planDigest,
  });

  // 8) 需求/验收引用重核（与导入同一契约语义）：缺失 not_found、跨项目
  //    forbidden 抛出；非可用状态/内容哈希不匹配固化 rejected。
  const references = [
    ...plan.feature.sourceRefs,
    ...plan.tasks.flatMap(task => [...task.requirementsRefs]),
  ];
  for (const ref of references) {
    let inputRef;
    try {
      inputRef = transaction.getArtifactInputRef(projectId, ref.artifactId);
    } catch (error) {
      if (isStorageError(error, 'conflict')) {
        return rejected({ reason: 'artifact_not_usable', entityType: 'artifact' });
      }
      if (error instanceof StorageError) {
        throw mapStorageError(error, { operation });
      }
      throw error;
    }
    if (ref.contentHash !== undefined && ref.contentHash !== inputRef.contentHash) {
      return rejected({ reason: 'artifact_content_hash_mismatch', entityType: 'artifact' });
    }
  }

  // 8) 成员分类与策略副本：既有成员保留既有策略副本（替换原语在存储层强制，
  //    不因当前默认配置或 complexity 编辑自动更换 executionConfig）；仅新
  //    成员按创建策略规则从本事务读取的当前配置复制完整策略与来源。
  const existingTaskIds = new Set(snapshot.tasks.map(task => task.id));
  const existingTaskById = new Map(snapshot.tasks.map(task => [task.id, task] as const));
  const newTaskIds = plan.tasks.filter(task => !existingTaskIds.has(task.id)).map(task => task.id);

  // 8a) 新成员既有业务 ID 重核：与库内任何其他 Feature 的任务冲突即固化
  //     rejected（与导入同一纪律，在任何业务写入之前决定）。
  const clashes = transaction.getTaskFeatureLinks(newTaskIds);
  if (clashes.size > 0) {
    return rejected({ reason: 'task_already_exists', entityType: 'task' });
  }
  // 9) 仅新成员的策略副本选择（既有成员不重选，见上）。
  const globalSettings = transaction.getGlobalSettingsOrNull();
  const projectSettings = transaction.getProjectSettingsOrNull(projectId);
  const selections = new Map<string, TaskStrategySelection>();
  for (const task of plan.tasks) {
    if (existingTaskIds.has(task.id)) {
      continue;
    }
    try {
      selections.set(
        task.id,
        selectTaskStrategy({
          ...(globalSettings === null
            ? {}
            : { global: { scopeRevision: globalSettings.revision, payload: globalSettings.payload } }),
          ...(projectSettings === null
            ? {}
            : { project: { scopeRevision: projectSettings.revision, payload: projectSettings.payload } }),
          ...(task.complexity === null ? {} : { complexity: task.complexity }),
        }),
      );
    } catch (error) {
      if (error instanceof StorageError) {
        throw mapStorageError(error, { operation });
      }
      throw error;
    }
  }

  // 10) 原子整体替换：Feature + 成员（保留/新建/移除）+ 边一次 CAS 一次递增。
  const replacement = transaction.replaceFeaturePlan({
    projectId,
    featureId,
    expectedRevision: envelope.expectedRevision,
    feature: {
      title: plan.feature.title,
      description: plan.feature.description,
      labels: [...plan.feature.labels],
      sourceRefs: plan.feature.sourceRefs.map(ref => ({ ...ref })),
      planDigest: plan.planDigest,
      planStatus: approval.planStatusAfter,
    },
    tasks: plan.tasks.map(task => {
      const existing = existingTaskById.get(task.id);
      const selection = selections.get(task.id);
      const strategy =
        selection !== undefined
          ? selection
          : {
              executionConfig: existing!.executionConfig as Record<string, unknown>,
              configSource: existing!.configSource,
              configSourceKey: existing!.configSourceKey,
            };
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        labels: [...task.labels],
        ...(task.complexity === null ? {} : { complexity: task.complexity }),
        acceptance: { criteria: [...task.acceptance.criteria] },
        requirementsRefs: task.requirementsRefs.map(ref => ({ ...ref })),
        executionConfig: strategy.executionConfig,
        configSource: strategy.configSource,
        configSourceKey: strategy.configSourceKey,
      };
    }),
    dependencies: plan.tasks.flatMap(task =>
      task.dependsOn.map(dependsOn => ({ taskId: task.id, dependsOnId: dependsOn })),
    ),
  });

  // 11) 同事务脱敏事件（恒定 payload；不携带计划正文/成员变更明细/批准语义）。
  transaction.appendPlanEvent({
    projectId,
    eventType: FEATURE_PLAN_REVISED_EVENT_TYPE,
    aggregateType: 'feature',
    aggregateId: replacement.feature.id,
    aggregateRevision: replacement.feature.revision,
    payload: { revised: true },
  });

  // 12) completed 回执：稳定业务 ID + 修订事实 + 有界成员分类 + 校验结果；
  //     不携带策略副本正文，不声称批准/可执行/Task 通过/无活动执行。
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      feature: toPublicFeatureRecord(replacement.feature),
      tasks: replacement.tasks.map(task => ({ id: task.id })),
      memberChanges: {
        keptTaskCount: replacement.keptTaskIds.length,
        createdTaskCount: replacement.createdTaskIds.length,
        removedTaskCount: replacement.removedTaskIds.length,
      },
      validation: {
        taskCount: plan.taskCount,
        dependencyEdgeCount: plan.dependencyEdgeCount,
        executable: plan.executable,
      },
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
