/**
 * P03-1 / F-005 单 Feature 计划导入应用用例（application 层；在调用方的同一
 * BEGIN IMMEDIATE 写事务内执行，无任何事务外 I/O）。
 *
 * 设计依据：docs/p03-1-plan-import-contract.md §2/§3/§6（计划 payload 契约、
 * 同 Feature DAG 校验、导入 CAS 与事务提交重核）、core-design/06 §3（创建
 * Task 时按复杂度/defaultStrategy 复制完整策略与来源）、core-design/03 §4
 * （受控制品引用）。
 *
 * 不变量：
 * - 本用例只在写事务内运行：项目授权、Phase 归属/open 状态/CAS、既有业务
 *   ID、需求-验收引用制品身份与当前全局/项目配置全部在同一短事务内重核；
 *   不在事务内等待文件、Git、模型或人审（引用仅做索引级身份重核，文件完整
 *   性 I/O 属制品发布/核对链路，不在本事务）；
 * - 冲突类业务拒绝（Phase CAS 不匹配、Phase 非 open、重复既有任务 ID、制品
 *   非可用/内容哈希不匹配）在任何业务写入之前固化 rejected 回执（P02 §5.5
 *   纪律）；不存在 completed 回执指向半成功计划；
 * - 结构/归属类失败（非法计划、缺依赖、跨 Feature 依赖、缺引用、跨项目、
 *   缺完整策略）以公开错误抛出（invalid_input/not_found/forbidden），零回执
 *   零写入，整组拒绝；
 * - 计划深校验复用 F-001 纯校验器（validateFeaturePlanInput），并以库内解析
 *   的既有任务身份为 externalTasks 上下文精确区分「缺依赖」与「跨 Feature
 *   依赖」；Task 创建时按 F-003 selectTaskStrategy 从本事务读取的当前配置
 *   复制完整策略与来源（默认配置之后变化不追溯既有 Task）；
 * - 导入只建立草稿：Feature 恒 draft(+plan_status=draft)、Task 恒 pending，
 *   不创建 Batch/Run/Attempt、不写批准、不声称 Task 通过或 Feature 完成；
 *   零 Task 草稿合法且校验结果明确 executable=false。
 */
import { randomBytes } from 'node:crypto';
import { isStorageError, StorageError } from '../ports/errors.js';
import {
  PublicError,
  createCompletedReceipt,
  createRejectedReceipt,
  mapStorageError,
} from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import { validateFeaturePlanInput } from '../ports/feature-plan.js';
import type { ValidatedFeaturePlan } from '../ports/feature-plan.js';
import { FEATURE_PLAN_IMPORTED_EVENT_TYPE } from '../ports/plan-store.js';
import type { PhaseRecord } from '../ports/plan-store.js';
import { toPublicFeatureRecord } from '../ports/queries.js';
import { selectTaskStrategy } from './task-strategy-selection.js';
import type { TaskStrategySelection } from './task-strategy-selection.js';

/** 计划导入命令操作名（与 COMMAND_OPERATIONS 白名单同一冻结名）。 */
export const FEATURE_PLAN_IMPORT_OPERATION = 'feature.plan.import' as const;

export type FeaturePlanImportEnvelope = Extract<
  import('../ports/commands.js').ValidatedCommandEnvelope,
  { operation: typeof FEATURE_PLAN_IMPORT_OPERATION }
>;

/** 导入提交身份（回执公共字段；由命令服务从信封与服务端时钟组装）。 */
export interface FeaturePlanImportIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof FEATURE_PLAN_IMPORT_OPERATION;
  readonly scope: FeaturePlanImportEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/** 计划校验错误 → 公开错误（字段定位改写为 payload.plan.*，不回显输入正文）。 */
function planValidationError(error: StorageError): PublicError {
  const mapped = mapStorageError(error, { operation: FEATURE_PLAN_IMPORT_OPERATION });
  const field = mapped.details?.field;
  if (typeof field !== 'string') {
    return mapped;
  }
  const details = { ...(mapped.details ?? {}) };
  details.field = field === 'input' ? 'payload.plan' : `payload.plan.${field}`;
  return new PublicError(mapped.code, FEATURE_PLAN_IMPORT_OPERATION, undefined, { details });
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
 * 提交单 Feature 计划导入：在调用方的同一写事务内完成全部重核与原子写入，
 * 返回持久化回执（completed/rejected）。除 saveReceipt 外的任何失败都以异常
 * 抛出（整组回滚，零回执）；冲突类业务拒绝在任何业务写入之前固化 rejected。
 */
export function submitFeaturePlanImport(
  identity: FeaturePlanImportIdentity,
  envelope: FeaturePlanImportEnvelope,
  transaction: CommandTransaction,
): CommandReceipt {
  const operation = FEATURE_PLAN_IMPORT_OPERATION;
  const projectId = envelope.scope.projectId;

  // 1) 父级项目把关：缺失/不可见统一 forbidden（不泄漏存在性；抛出）。
  try {
    transaction.getProject(projectId);
  } catch (error) {
    mapProjectLookupError(error, operation);
  }

  // 2) Phase 归属：缺失 not_found、跨项目 forbidden（抛出，零写入）。
  const phase: PhaseRecord = transaction.getPhase(projectId, envelope.payload.phaseId);

  const rejected = (details: Record<string, unknown>): CommandReceipt => {
    const receipt = createRejectedReceipt({
      ...identity,
      error: new PublicError('conflict', operation, undefined, { details }),
    });
    transaction.saveReceipt(receipt);
    return receipt;
  };

  // 3) Phase 生命周期与聚合 CAS：写入之前的确定性业务拒绝，固化 rejected。
  if (phase.status !== 'open') {
    return rejected({ reason: 'phase_not_open', entityType: 'phase' });
  }
  if (phase.revision !== envelope.expectedRevision) {
    return rejected({
      reason: 'conflict',
      expectedRevision: envelope.expectedRevision,
      actualRevision: phase.revision,
      entityType: 'phase',
    });
  }

  // 4) 计划深校验：复用 F-001 纯校验器 + 库内既有任务解析（externalTasks），
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

  // 5) 既有业务 ID 重核：计划任务 ID 与库内任何既有任务冲突即整组拒绝。
  const existingTaskIds = transaction.getTaskFeatureLinks(plan.tasks.map(task => task.id));
  if (existingTaskIds.size > 0) {
    return rejected({ reason: 'task_already_exists', entityType: 'task' });
  }

  // 6) 需求/验收引用重核（复用 Artifact 受控查询契约语义）：缺失 not_found、
  //    跨项目 forbidden 抛出；非可用状态/内容哈希不匹配固化 rejected。
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
      // 缺失/跨项目等归属类失败：抛公开错误（不积回执，零写入）。
      if (error instanceof StorageError) {
        throw mapStorageError(error, { operation });
      }
      throw error;
    }
    if (ref.contentHash !== undefined && ref.contentHash !== inputRef.contentHash) {
      // 引用绑定到具体内容版本：与制品当前不可变内容身份不一致即拒绝。
      return rejected({ reason: 'artifact_content_hash_mismatch', entityType: 'artifact' });
    }
  }

  // 7) 完整策略副本：从本事务读取的当前全局/项目配置解析（F-003 纯选择）；
  //    无匹配（no_strategy_match）抛 invalid_input，整组拒绝。
  const globalSettings = transaction.getGlobalSettingsOrNull();
  const projectSettings = transaction.getProjectSettingsOrNull(projectId);
  const selections = new Map<string, TaskStrategySelection>();
  for (const task of plan.tasks) {
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

  // 8) 原子写入：Feature + Tasks + 依赖边 + feature.plan.imported 脱敏事件。
  const feature = transaction.insertFeature({
    projectId,
    phaseId: phase.id,
    title: plan.feature.title,
    description: plan.feature.description,
    labels: [...plan.feature.labels],
    sourceRefs: plan.feature.sourceRefs.map(ref => ({ ...ref })),
    planDigest: plan.planDigest,
  });
  for (const task of plan.tasks) {
    const selection = selections.get(task.id);
    if (selection === undefined) {
      throw new TypeError(`导入策略选择缺少任务 ${task.id} 的副本（编程错误）`);
    }
    transaction.insertTask({
      projectId,
      featureId: feature.id,
      id: task.id,
      title: task.title,
      description: task.description,
      labels: [...task.labels],
      ...(task.complexity === null ? {} : { complexity: task.complexity }),
      acceptance: { criteria: [...task.acceptance.criteria] },
      requirementsRefs: task.requirementsRefs.map(ref => ({ ...ref })),
      executionConfig: selection.executionConfig,
      configSource: selection.configSource,
      configSourceKey: selection.configSourceKey,
    });
  }
  for (const task of plan.tasks) {
    for (const dependsOn of task.dependsOn) {
      transaction.insertTaskDependency({
        projectId,
        featureId: feature.id,
        taskId: task.id,
        dependsOnId: dependsOn,
      });
    }
  }
  transaction.appendPlanEvent({
    projectId,
    eventType: FEATURE_PLAN_IMPORTED_EVENT_TYPE,
    aggregateType: 'feature',
    aggregateId: feature.id,
    aggregateRevision: feature.revision,
    payload: { imported: true },
  });

  // 9) completed 回执：稳定业务 ID + draft 事实 + planDigest + 校验结果；
  //    不携带策略副本正文（有界结果），不声称批准/可执行/Task 通过。
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      feature: toPublicFeatureRecord(feature),
      tasks: plan.tasks.map(task => ({ id: task.id })),
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
