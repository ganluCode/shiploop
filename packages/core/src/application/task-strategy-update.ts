/**
 * P03-2 / F-001 Task 策略副本授权 CAS 编辑应用用例（application 层；在调用方
 * 的同一 BEGIN IMMEDIATE 写事务内执行，无任何事务外 I/O）。
 *
 * 设计依据：p03-plan-approval PRD（版本 0.3）FR-1「批准前可 CAS 修改副本；
 * 项目默认或 complexity 改变不自动换模型；秘密正文不得落库；活动 Attempt
 * 禁止热改策略」、docs/p03-1-task-strategy-selection.md（F-003 副本/来源契约；
 * 其范围边界将 Task 策略编辑留给本任务定案）与
 * docs/p03-2-task-strategy-edit-contract.md（本模块契约文档）。
 *
 * 不变量：
 * - 编辑的是**已创建 Task 的完整 executionConfig 副本**：输入必须是完整
 *   schemaVersion=2 策略条目（runtime/provider/model 必需，可选 credentialRef/
 *   endpointRef），复用 F-003 validateTaskExecutionConfig 与
 *   validateRuntimeStrategyCapabilities（可信目录）同一套校验，不另立第二套、
 *   不跨来源补字段、不回落其他厂商/模型、不从当前默认配置重读路由；
 * - configSource/configSourceKey 表达**实际来源而非动态配置指针**：编辑成功后
 *   定值为 task_edit/taskEdit（编辑前来源说明被显式覆盖），来源仅供追踪，不是
 *   执行时动态引用；批准前的可选 Task 覆盖复用本编辑规则，不存在第二条绕过
 *   CAS 的写入通道；
 * - 不追溯、不外溢：项目 modelMap 更新与 Task complexity 更新均不触发本用例
 *   （默认不重选）；显式编辑只影响目标 Task（其他 Task 副本/来源、既有证据与
 *   累计计数、Feature planDigest/planStatus/revision 保持不变；planDigest 的
 *   摘要规范化白名单不含策略副本与来源）；
 * - expectedRevision 唯一权威来源是命令信封顶层（目标 Task 自身 revision）：
 *   旧 revision 固化 rejected 回执（conflict），同 revision 竞争编辑/标签编辑
 *   经单语句条件 UPDATE 裁决仅一个生效（与 F-007 共用同一 Task CAS 空间）；
 * - 活动执行输入保护在同一写事务内重核（沿用 F-008 探测端口纪律）：queued/
 *   running/paused/停止未知等活动依据不能被策略热改覆盖（暂停不视为安全停止）；
 *   探测失败 fail-closed——异常传播整组回滚，绝不默认为「无活动」。未来
 *   start/claim 引入 Run/Attempt 后必须以真实库内查询实现本探测并遵守同一
 *   事务与 CAS 契约；本用例不创建调度器或 Attempt 表来模拟后序能力；
 * - 能力校验只依赖可信装配注入的只读能力目录（validateRuntimeStrategyCapabilities
 *   与配置命令同一目录）；目录未装配时命令 unsupported，空目录 fail-closed
 *   （任何 runtime 含 Pi/Fake 都不伪装受支持）；
 * - 编辑成功在同一事务内追加 task.strategy.updated 脱敏事件（payload 恒
 *   {strategyUpdated:true}）与 completed 回执（结果有界，不回显秘密正文、
 *   不声称批准/可执行/执行结果）。
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
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import { validateRuntimeStrategyCapabilities } from '../ports/runtime-capabilities.js';
import {
  TASK_STRATEGY_UPDATED_EVENT_TYPE,
} from '../ports/plan-store.js';
import { toPublicTaskRecord } from '../ports/queries.js';
import type { ActiveExecutionInputState } from './feature-plan-revise.js';
import { validateTaskExecutionConfig } from './task-strategy-selection.js';

/** Task 策略编辑命令操作名（与 COMMAND_OPERATIONS 白名单同一冻结名）。 */
export const TASK_STRATEGY_UPDATE_OPERATION = 'task.strategy.update' as const;

/**
 * F-001（P03-2）纯规则（core-design/02 §10 与 PRD FR-1 的可核对冻结面）：
 * Task 策略 CAS 编辑的影响面。只替换目标 Task 的完整策略副本与来源说明并
 * 递增其自身 revision；不重读默认路由（modelMap/complexity 变化不触发）、
 * 不改计划业务身份（planDigest 摘要白名单不含策略副本/来源，批准绑定不失效）、
 * 不影响其他 Task/Feature/依赖/验收、不创建任何执行实体；活动执行输入保护在
 * 同一写事务内 fail-closed 重核。与纯标签编辑（PLAN_LABELS_EDIT_IMPACT）、
 * 实质计划修订（PLAN_REVISE_IMPACT）是可区分的契约。
 */
export const TASK_STRATEGY_EDIT_IMPACT = Object.freeze({
  changesTaskStrategy: true,
  changesTaskOwnRevision: true,
  rereadsDefaultRouting: false,
  retroactiveOnConfigOrComplexityChanges: false,
  changesPlanDigest: false,
  changesPlanStatus: false,
  changesOtherTasksOrFeature: false,
  invalidatesDigestBoundApprovals: false,
  propagatesToParentOrChild: false,
  requiresSameTransactionActivityGuard: true,
  createsExecutionEntities: false,
});

/**
 * 编辑后来源词汇（P03-2 / F-001 定案，扩展 F-003 创建时词汇
 * project_default/global_default/user_override；选择模块词汇不变）：显式授权
 * CAS 编辑。config_source 列仅有非空 CHECK（迁移 v6），追加取值无需迁移。
 */
export const TASK_STRATEGY_EDIT_CONFIG_SOURCE = 'task_edit' as const;
/** 编辑来源的 sourceKey（来源键路径；仅解释用途，不是执行时动态引用）。 */
export const TASK_STRATEGY_EDIT_SOURCE_KEY = 'taskEdit' as const;

/**
 * Task 活动执行输入保护探测：在编辑的同一写事务内调用（BEGIN IMMEDIATE
 * 串行化，探测结果与后续写入之间不存在竞争窗口）。探测抛出即 fail-closed
 * ——整组回滚、不写回执，绝不把查询失败默认为「无活动」。未来 start/claim
 * 引入 Run/Attempt 后必须以真实库内查询实现本探测并遵守同一事务与 CAS 契约。
 */
export type TaskActiveExecutionInputProbe = (target: {
  readonly projectId: string;
  readonly taskId: string;
}) => ActiveExecutionInputState;

/**
 * 生产默认探测：P03-2 当前存储无 Run/Attempt 表（迁移 v6 只有计划结构四表），
 * 不存在可活动的 Task 执行实体，故恒返回「无活动」。这是明确的能力边界
 * 宣告——不是「查询失败当作无活动」的兜底；执行实体表随执行链路（后续阶段）
 * 引入时必须替换为同事务真实查询（fail-closed），不得沿用本常量伪装已核验。
 */
export const NO_ACTIVE_TASK_EXECUTION_INPUTS_PROBE: TaskActiveExecutionInputProbe = () => ({
  active: false,
});

/** 编辑守卫（受控测试装配注入活动探测；缺省为生产无执行实体表边界宣告）。 */
export interface TaskStrategyEditGuards {
  readonly activeTaskExecutionInputs: TaskActiveExecutionInputProbe;
}

export type TaskStrategyUpdateEnvelope = Extract<
  import('../ports/commands.js').ValidatedCommandEnvelope,
  { operation: typeof TASK_STRATEGY_UPDATE_OPERATION }
>;

/** 策略编辑提交身份（回执公共字段；由命令服务从信封与服务端时钟组装）。 */
export interface TaskStrategyUpdateIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof TASK_STRATEGY_UPDATE_OPERATION;
  readonly scope: TaskStrategyUpdateEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/** 编辑依赖（能力目录必选；活动探测守卫缺省为生产边界宣告）。 */
export interface TaskStrategyEditDeps {
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
  readonly guards?: TaskStrategyEditGuards;
}

/** 策略语义/能力校验错误 → 公开错误（字段定位改写为 payload.executionConfig.*，不回显输入正文）。 */
function strategyValidationError(error: StorageError): PublicError {
  const mapped = mapStorageError(error, { operation: TASK_STRATEGY_UPDATE_OPERATION });
  const field = mapped.details?.field;
  if (typeof field !== 'string') {
    return mapped;
  }
  const details = { ...(mapped.details ?? {}) };
  // 校验器字段已携带 executionConfig 前缀（executionConfig.runtime 等），直接
  // 映射为 payload.<field>；无前缀的防御性形态补齐前缀。
  details.field = field.startsWith('executionConfig')
    ? `payload.${field}`
    : `payload.executionConfig.${field}`;
  return new PublicError(mapped.code, TASK_STRATEGY_UPDATE_OPERATION, undefined, { details });
}

/**
 * 提交 Task 策略副本 CAS 编辑：在调用方的同一写事务内完成归属/活动保护/CAS
 * 重核、完整策略语义与能力兼容校验、副本替换、脱敏事件与回执。除 saveReceipt
 * 外的任何失败都以异常抛出（整组回滚，零回执）；活动保护与 CAS 冲突在任何
 * 业务写入之前固化 rejected。
 */
export function submitTaskStrategyUpdate(
  identity: TaskStrategyUpdateIdentity,
  envelope: TaskStrategyUpdateEnvelope,
  transaction: CommandTransaction,
  deps: TaskStrategyEditDeps,
): CommandReceipt {
  const operation = TASK_STRATEGY_UPDATE_OPERATION;
  const projectId = envelope.scope.projectId;
  const taskId = envelope.payload.taskId;

  // 1) 父级项目把关：缺失/不可见统一 forbidden（不泄漏存在性；抛出）。
  try {
    transaction.getProject(projectId);
  } catch (error) {
    mapProjectLookupError(error, operation);
  }

  // 2) 目标 Task 读取：缺失 not_found、跨项目 ownership（抛出，零写入）。
  const task = transaction.getTask(projectId, taskId);

  const rejected = (details: Record<string, unknown>): CommandReceipt => {
    const receipt = createRejectedReceipt({
      ...identity,
      error: new PublicError('conflict', operation, undefined, { details }),
    });
    transaction.saveReceipt(receipt);
    return receipt;
  };

  // 3) 活动执行输入保护（同一写事务重核；fail-closed）：queued/running/
  //    paused/停止未知等活动依据不能被策略热改覆盖（暂停不视为安全停止）；
  //    探测异常直接传播整组回滚（不写回执），绝不默认为「无活动」。
  const activity = (deps.guards ?? { activeTaskExecutionInputs: NO_ACTIVE_TASK_EXECUTION_INPUTS_PROBE })
    .activeTaskExecutionInputs({ projectId, taskId });
  if (activity.active) {
    // details 键受限控白名单（field/reason/expectedRevision/actualRevision/
    // entityType），活动证据种类不进入回执（不泄漏执行细节）。
    return rejected({ reason: 'active_execution_inputs', entityType: 'task' });
  }

  // 4) Task 自身 CAS：写入之前的确定性业务拒绝，固化 rejected。
  if (task.revision !== envelope.expectedRevision) {
    return rejected({
      reason: 'conflict',
      expectedRevision: envelope.expectedRevision,
      actualRevision: task.revision,
      entityType: 'task',
    });
  }

  // 5) 完整策略语义校验（复用 F-003 validateTaskExecutionConfig：缺任一必需
  //    字段、孤立 model 覆盖、未知键、秘密正文字段、非法引用一律拒绝，不从
  //    既有副本或默认配置拼补）+ 能力兼容校验（复用可信目录：未知 runtime/
  //    不兼容 provider/model 拒绝；空目录 fail-closed）。失败抛 invalid_input，
  //    零写入零回执。
  let executionConfig;
  try {
    executionConfig = validateTaskExecutionConfig(envelope.payload.executionConfig, operation);
  } catch (error) {
    if (error instanceof StorageError) {
      throw strategyValidationError(error);
    }
    throw error;
  }
  try {
    validateRuntimeStrategyCapabilities(executionConfig, deps.capabilityCatalog, {
      operation,
      entity: { type: 'task', projectId, id: taskId },
    }, 'executionConfig');
  } catch (error) {
    if (error instanceof StorageError) {
      throw strategyValidationError(error);
    }
    throw error;
  }

  // 6) 策略副本 CAS 替换：单语句条件 UPDATE 只触达目标 Task 的策略三列 +
  //    revision/updated_at；来源定值为 task_edit/taskEdit（实际来源，非动态
  //    配置指针）。CAS 不匹配（与步骤 4 之间的串行化窗口内被并发编辑递增）
  //    固化 rejected。
  let updated;
  try {
    updated = transaction.updateTaskStrategy({
      projectId,
      taskId,
      executionConfig,
      configSource: TASK_STRATEGY_EDIT_CONFIG_SOURCE,
      configSourceKey: TASK_STRATEGY_EDIT_SOURCE_KEY,
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

  // 7) 同事务脱敏事件（恒定 payload；不携带策略副本正文/凭据引用/批准语义）。
  transaction.appendPlanEvent({
    projectId,
    eventType: TASK_STRATEGY_UPDATED_EVENT_TYPE,
    aggregateType: 'task',
    aggregateId: updated.id,
    aggregateRevision: updated.revision,
    payload: { strategyUpdated: true },
  });

  // 8) completed 回执：有界结果携带本次编辑后的 Task 公共记录（策略副本与
  //    来源是编辑事实本身）；不声称批准、可执行或执行结果。
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: { task: toPublicTaskRecord(updated) },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
