/**
 * F-003 公开事件封套映射、快照水位与 SSE 游标纯契约（ports 契约层）。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md
 * - §8 快照水位：watermark 为同一 SQLite 一致读视图内
 *   MAX(state_events.sequence)，空库为 0；水位游标绑定数据根身份与 scope，
 *   具体的一致读视图组装在 F-010；
 * - §9.1 事件封套 schemaVersion=1（独立于发现版本 1/线协议版本 1/线消息
 *   版本 2/配置 payload 版本 2）：从持久行列单向映射，不添加不存在的
 *   Run/Task/Attempt 身份，全局事件 scope.kind='global' 且无 projectId；
 * - §9.2 事件类型白名单（P02-2 六类 + P02-3 / F-007 §9.2 扩展的五类基线事件）：
 *   type ↔ aggregate_type ↔ project_id ↔ payload 形状冻结。**F-003 定案**：映射层遇到未知持久类型或不一致行列一律显式失败
 *   （corrupt_state），不静默跳过、不伪造、不蒙混透传未知 payload 键——
 *   P02-2 不做事件清理，所有事件仅由白名单写入路径产生，行列异常只可能来自
 *   持久损坏或库外篡改；F-012 按 §9.4 以 error 帧/错误响应呈现；
 * - §9.3 游标 evcur_v1_<base64url>：{v:1,seq,root,sk}，root 为数据根身份
 *   （64hex SHA-256）前 16hex，sk 为 scope 指纹（project 含 projectId，
 *   global 为固定值）；任何无法解码/版本未知/seq 非法/root 或 scope 不符
 *   都是 invalid_input(invalid_cursor)，绝不当作从零读取；seq 超过当前
 *   水位（未来游标）合法，等待新事件是调用方策略，本层不接触水位；
 * - §13 补读分页默认 100、上限 500。
 *
 * 纯度不变量：只做结构校验与数据映射；node:crypto 仅用于确定性指纹计算
 * （不读时钟/文件系统/网络），不导入 HTTP/SSE/ORM/Pi SDK/适配器，
 * 不从 logger 文本推断事件（持久读取端口已于 F-010 落地：
 * StateEventPageRequest/validateStateEventPageRequest 与 StateEventReadStore，
 * 见本文件末节；SSE 订阅在 F-012）。
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isUuidV4, PublicError } from './commands.js';
import { PROJECT_PROFILE_AUDIT_TYPES, validateProfileAuditPayload } from './project-profile-store.js';
import {
  BASELINE_CHECK_STATUSES,
  BASELINE_CHECKS_MAX,
  BASELINE_CHECKS_MIN,
  BASELINE_OPERATION_STATUSES,
  BASELINE_REASON_CODES,
} from './baseline.js';
import { isStorageError } from './errors.js';
import { ATTEMPT_UPDATED_EVENT_TYPE, TASK_APPROVAL_BLOCKED_EVENT_TYPE, TASK_APPROVAL_DECIDED_EVENT_TYPE, EXECUTION_BUDGET_REVISED_EVENT_TYPE, EXECUTION_RUN_DISPATCHED_EVENT_TYPE, EXECUTION_RUN_LABELS_UPDATED_EVENT_TYPE, EXECUTION_RUN_PAUSED_EVENT_TYPE, EXECUTION_BATCH_PAUSED_EVENT_TYPE, EXECUTION_RUN_CANCELLING_EVENT_TYPE, EXECUTION_RUN_CANCELLED_EVENT_TYPE, EXECUTION_BATCH_CANCELLING_EVENT_TYPE, EXECUTION_BATCH_CANCELLED_EVENT_TYPE, EXECUTION_RUN_RESUMED_EVENT_TYPE, EXECUTION_BATCH_RESUMED_EVENT_TYPE, EXECUTION_FEATURE_PAUSED_EVENT_TYPE, EXECUTION_FEATURE_CANCELLING_EVENT_TYPE, EXECUTION_FEATURE_CANCELLED_EVENT_TYPE, EXECUTION_FEATURE_RESUMED_EVENT_TYPE, TASK_CLAIMED_EVENT_TYPE, FEATURE_FINALIZED_EVENT_TYPE, FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE } from './execution-store.js';
import {
  EXECUTION_INPUT_PREPARED_EVENT_TYPE,
  FEATURE_DAG_UPDATED_EVENT_TYPE,
  FEATURE_LABELS_UPDATED_EVENT_TYPE,
  FEATURE_PLAN_IMPORTED_EVENT_TYPE,
  FEATURE_PLAN_REVISED_EVENT_TYPE,
  FEATURE_PLAN_APPROVED_EVENT_TYPE,
  FEATURE_PLAN_REJECTED_EVENT_TYPE,
  PHASE_CREATED_EVENT_TYPE,
  PHASE_LABELS_UPDATED_EVENT_TYPE,
  TASK_LABELS_UPDATED_EVENT_TYPE,
  TASK_STRATEGY_UPDATED_EVENT_TYPE,
} from './plan-store.js';
import { SETTINGS_SCHEMA_VERSION } from './settings-schema.js';
import {
  GLOBAL_SETTINGS_CREATED_EVENT_TYPE as SETTINGS_GLOBAL_CREATED_EVENT_TYPE,
  GLOBAL_SETTINGS_ID,
  GLOBAL_SETTINGS_UPDATED_EVENT_TYPE,
  PROJECT_METADATA_UPDATED_EVENT_TYPE,
  PROJECT_REGISTERED_EVENT_TYPE,
  PROJECT_REPOSITORY_REBOUND_EVENT_TYPE,
  PROJECT_SETTINGS_CREATED_EVENT_TYPE as SETTINGS_PROJECT_CREATED_EVENT_TYPE,
  PROJECT_SETTINGS_UPDATED_EVENT_TYPE,
} from './state-store.js';
import type { StateEventAggregateType } from './state-store.js';
import { ATTEMPT_EXECUTION_STAGES } from './attempt-store.js';
import { WORKSPACE_EVENT_TYPE, WORKSPACE_OPERATION_STATUSES } from './workspace.js';
import { GIT_OPERATION_TERMINAL_STATUSES } from './git-operations.js';
import { validateStableId } from './validation.js';
import { validateWorkProcessIdentity } from './work-resources.js';

/** 事件读取面的默认操作身份（快照/SSE/补读映射共用；具体路由可传自己的 operation）。 */
export const EVENT_READ_OPERATION = 'events.read';

/** 公开事件封套版本（§9.1，独立于线消息/发现/线协议/配置 payload 版本）。 */
export const PUBLIC_EVENT_SCHEMA_VERSION = 1 as const;

/** 仅命令路径注册成功写入（F-008）；P01 直接服务首建不写事件（契约 §15.3）。 */
export { PROJECT_REGISTERED_EVENT_TYPE };
/** P06-5：重新绑定事件保留旧/新 binding 身份与 revision。 */
export { PROJECT_REPOSITORY_REBOUND_EVENT_TYPE };
/** P03-1 / F-004：仅命令路径 Phase 创建成功写入（脱敏 payload 恒为 {created:true}）。 */
export { PHASE_CREATED_EVENT_TYPE };
/** P03-1 / F-005：仅命令路径 Feature 计划导入成功写入（脱敏 payload 恒 {imported:true}）。 */
export { FEATURE_DAG_UPDATED_EVENT_TYPE };
export { FEATURE_PLAN_IMPORTED_EVENT_TYPE };
/**
 * P03-1 / F-007：仅命令路径纯标签 CAS 编辑成功写入（脱敏 payload 恒
 * {labelsUpdated:true}，聚合为目标实体自身，不携带标签正文/计划语义）。
 */
export { PHASE_LABELS_UPDATED_EVENT_TYPE, FEATURE_LABELS_UPDATED_EVENT_TYPE, TASK_LABELS_UPDATED_EVENT_TYPE };
/** P03-1 / F-008：仅命令路径实质计划修订成功写入（脱敏 payload 恒 {revised:true}）。 */
export { FEATURE_PLAN_REVISED_EVENT_TYPE };
/** P03-2 / F-001：仅命令路径 Task 策略副本 CAS 编辑成功写入（脱敏 payload 恒 {strategyUpdated:true}）。 */
export { TASK_STRATEGY_UPDATED_EVENT_TYPE };
/** P03-2 / F-002：仅命令路径计划批准成功写入（脱敏 payload 恒 {approved:true}）。 */
export { FEATURE_PLAN_APPROVED_EVENT_TYPE };
/** P03-2 / F-002：仅命令路径计划拒绝成功写入（脱敏 payload 恒 {rejected:true}）。 */
export { FEATURE_PLAN_REJECTED_EVENT_TYPE };
/** P03-2 / F-006：仅命令路径最终重核通过后写入（脱敏 payload 恒 {prepared:true}）。 */
export { EXECUTION_INPUT_PREPARED_EVENT_TYPE };
/** P03-3 / F-005：仅命令路径派发成功后写入（脱敏 payload 恒 {dispatched:true}）。 */
export { EXECUTION_RUN_DISPATCHED_EVENT_TYPE };
/** P03-3 / F-009：仅命令路径预算修订成功后写入（脱敏 payload 恒 {revised:true}）。 */
export { EXECUTION_BUDGET_REVISED_EVENT_TYPE };
/** P03-9 / F-001：仅暂停命令成功写入（Run/Batch 各自聚合；payload 恒 {paused:true}）。 */
export { EXECUTION_RUN_PAUSED_EVENT_TYPE, EXECUTION_BATCH_PAUSED_EVENT_TYPE, EXECUTION_FEATURE_PAUSED_EVENT_TYPE };
/** P03-9 / F-008：仅显式 resume 命令成功写入（payload 恒 {resumed:true}）。 */
export { EXECUTION_RUN_RESUMED_EVENT_TYPE, EXECUTION_BATCH_RESUMED_EVENT_TYPE, EXECUTION_FEATURE_RESUMED_EVENT_TYPE };
/** P03-9 / F-002：仅取消命令成功写入（cancelling 意图与 cancelled 终态可区分）。 */
export { EXECUTION_RUN_CANCELLING_EVENT_TYPE, EXECUTION_RUN_CANCELLED_EVENT_TYPE, EXECUTION_BATCH_CANCELLING_EVENT_TYPE, EXECUTION_BATCH_CANCELLED_EVENT_TYPE, EXECUTION_FEATURE_CANCELLING_EVENT_TYPE, EXECUTION_FEATURE_CANCELLED_EVENT_TYPE };
/** 仅命令路径全局配置首建成功写入（F-009 已实施；P01 直接服务首建不写事件）。 */
export { SETTINGS_GLOBAL_CREATED_EVENT_TYPE };
/** 仅命令路径项目配置首建成功写入（F-009 已实施；P01 直接服务首建不写事件）。 */
export { SETTINGS_PROJECT_CREATED_EVENT_TYPE };

/** §9.2 P02-3 / F-007 基线事件类型常量（白名单扩展，§9.3 随迁移 v4 生效）。 */
export const BASELINE_AUTHORIZED_EVENT_TYPE = 'baseline.authorized';
export const BASELINE_STARTED_EVENT_TYPE = 'baseline.started';
export const BASELINE_CHECK_COMPLETED_EVENT_TYPE = 'baseline.check_completed';
export const BASELINE_COMPLETED_EVENT_TYPE = 'baseline.completed';
export const BASELINE_CANCELLED_EVENT_TYPE = 'baseline.cancelled';

/** P03-8 / F-002：Git 操作意图登记/终态回执事件（聚合为 Git operation 自身）。 */
export const GIT_OPERATION_REGISTERED_EVENT_TYPE = 'git.operation.registered';
export const GIT_OPERATION_SETTLED_EVENT_TYPE = 'git.operation.settled';

/** §9.2 P02-2 事件类型白名单（顺序即冻结顺序；白名单外不得出现在公开流中）。 */
export const PUBLIC_STATE_EVENT_TYPES = [
  ...PROJECT_PROFILE_AUDIT_TYPES,
  PROJECT_REGISTERED_EVENT_TYPE,
  PROJECT_REPOSITORY_REBOUND_EVENT_TYPE,
  PROJECT_METADATA_UPDATED_EVENT_TYPE,
  SETTINGS_GLOBAL_CREATED_EVENT_TYPE,
  SETTINGS_PROJECT_CREATED_EVENT_TYPE,
  GLOBAL_SETTINGS_UPDATED_EVENT_TYPE,
  PROJECT_SETTINGS_UPDATED_EVENT_TYPE,
  BASELINE_AUTHORIZED_EVENT_TYPE,
  BASELINE_STARTED_EVENT_TYPE,
  BASELINE_CHECK_COMPLETED_EVENT_TYPE,
  BASELINE_COMPLETED_EVENT_TYPE,
  BASELINE_CANCELLED_EVENT_TYPE,
  // P03-1 / F-004：计划域事件白名单扩展（aggregate_type='phase'）。
  PHASE_CREATED_EVENT_TYPE,
  'phase.delivery.approved',
  'phase.delivery.invalidated',
  'phase.metadata.updated',
  'phase.closed',
  'phase.reopened',
  'phase.archived',
  'feature.phase.moved',
  // P05-2 / F-005：Phase Feature DAG 边集更新事件（聚合为 Phase）。
  FEATURE_DAG_UPDATED_EVENT_TYPE,
  // P03-1 / F-005：计划域事件白名单扩展（aggregate_type='feature'）。
  FEATURE_PLAN_IMPORTED_EVENT_TYPE,
  // P03-1 / F-007：纯标签 CAS 编辑事件（phase/feature/task 三个目标实体各自一条）。
  PHASE_LABELS_UPDATED_EVENT_TYPE,
  FEATURE_LABELS_UPDATED_EVENT_TYPE,
  TASK_LABELS_UPDATED_EVENT_TYPE,
  // P03-1 / F-008：实质计划修订事件（聚合为目标 Feature 自身）。
  FEATURE_PLAN_REVISED_EVENT_TYPE,
  // P03-2 / F-001：Task 策略副本 CAS 编辑事件（聚合为目标 Task 自身）。
  TASK_STRATEGY_UPDATED_EVENT_TYPE,
  // P03-2 / F-002：计划批准/拒绝决策事件（聚合为目标 Feature 自身，两类
  // 事件可区分，不把拒绝伪装为批准）。
  FEATURE_PLAN_APPROVED_EVENT_TYPE,
  FEATURE_PLAN_REJECTED_EVENT_TYPE,
  // P03-2 / F-006：执行输入制品组准备完成事件（聚合为目标 Task 自身；
  // payload 恒为 {prepared:true}，不携带制品正文/策略副本/执行语义）。
  EXECUTION_INPUT_PREPARED_EVENT_TYPE,
  // P03-3 / F-009：执行 Run 派发事件（聚合为派发创建的 Run 自身；payload 恒为
  // {dispatched:true}，不携带预算数值/计划正文/输入正文——派发不等于 Runtime
  // 已启动，不伪造执行进度）。
  EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
  // F-005：Run 纯标签编辑事件，payload 恒为 {labelsUpdated:true}。
  EXECUTION_RUN_LABELS_UPDATED_EVENT_TYPE,
  // P03-3 / F-009：批次预算修订事件（聚合为目标 Batch 自身；payload 恒为
  // {revised:true}，不携带预算数值/理由正文/批准主体——审计细节在不可变修订行
  // 与回执；修订不自动启动或恢复 Run）。
  EXECUTION_BUDGET_REVISED_EVENT_TYPE,
  EXECUTION_RUN_PAUSED_EVENT_TYPE,
  EXECUTION_BATCH_PAUSED_EVENT_TYPE,
  EXECUTION_RUN_CANCELLING_EVENT_TYPE,
  EXECUTION_RUN_CANCELLED_EVENT_TYPE,
  EXECUTION_BATCH_CANCELLING_EVENT_TYPE,
  EXECUTION_BATCH_CANCELLED_EVENT_TYPE,
  EXECUTION_RUN_RESUMED_EVENT_TYPE,
  EXECUTION_BATCH_RESUMED_EVENT_TYPE,
  EXECUTION_FEATURE_PAUSED_EVENT_TYPE,
  EXECUTION_FEATURE_CANCELLING_EVENT_TYPE,
  EXECUTION_FEATURE_CANCELLED_EVENT_TYPE,
  EXECUTION_FEATURE_RESUMED_EVENT_TYPE,
  TASK_CLAIMED_EVENT_TYPE,
  ATTEMPT_UPDATED_EVENT_TYPE,
  TASK_APPROVAL_BLOCKED_EVENT_TYPE,
  TASK_APPROVAL_DECIDED_EVENT_TYPE,
  FEATURE_FINALIZED_EVENT_TYPE,
  FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE,
  WORKSPACE_EVENT_TYPE,
  // P03-8 / F-002：受控 Git 操作意图与终态回执（payload 仅 operationId/status）。
  GIT_OPERATION_REGISTERED_EVENT_TYPE,
  GIT_OPERATION_SETTLED_EVENT_TYPE,
  'work.recovery.updated',
  'work.recovery.blocked',
] as const;

export type PublicStateEventType = (typeof PUBLIC_STATE_EVENT_TYPES)[number];

type EventPayloadKind =
  | 'projectProfile'
  | 'registered'
  | 'repositoryRebound'
  | 'changedFields'
  | 'settingsSummary'
  | 'baselineAuthorized'
  | 'baselineStarted'
  | 'baselineCheckCompleted'
  | 'baselineCompleted'
  | 'baselineCancelled'
  | 'phaseCreated'
  | 'phaseDelivery'
  | 'phaseMutation'
  | 'featurePhaseMoved'
  | 'featureDagUpdated'
  | 'featurePlanImported'
  | 'planLabelsUpdated'
  | 'featurePlanRevised'
  | 'taskStrategyUpdated'
  | 'featurePlanApproved'
  | 'featurePlanRejected'
  | 'executionInputPrepared'
  | 'executionRunDispatched'
  | 'executionBudgetRevised'
  | 'executionPaused'
  | 'executionResumed'
  | 'executionCancelling'
  | 'executionCancelled'
  | 'taskClaimed'
  | 'attemptUpdated'
  | 'taskApprovalBlocked'
  | 'taskApprovalDecided'
  | 'featureFinalized'
  | 'featureFinalizationBlocked'
  | 'workspaceOperationUpdated'
  | 'gitOperationRegistered'
  | 'gitOperationSettled'
  | 'workRecovery';

/** Validate rich durable recovery evidence before projecting the public notification. */
function validateWorkRecoveryPayload(payload: Record<string, unknown>, operation: string, global: boolean): void {
  if (payload.schemaVersion !== 1) corrupt(operation, 'event_payload_violation');
  if (global) {
    if (payload.phase === 'failed') {
      exactPayloadKeys(operation, payload, ['schemaVersion', 'phase', 'reason']);
      if (payload.reason !== 'recovery_failed') corrupt(operation, 'event_payload_violation');
    } else if (payload.phase === 'scan_limited') {
      exactPayloadKeys(operation, payload, ['schemaVersion', 'phase', 'limit']);
      if (!isSafeInteger(payload.limit, 1, 1_000)) corrupt(operation, 'event_payload_violation');
    } else corrupt(operation, 'event_payload_violation');
    return;
  }
  if (payload.phase === 'run_interrupted') {
    exactPayloadKeys(operation, payload, ['schemaVersion', 'phase', 'reason']);
    if (payload.reason !== 'restart_recovery') corrupt(operation, 'event_payload_violation');
    return;
  }
  const observation = payload.phase === 'observed' || payload.phase === 'recorded';
  if (!observation && payload.phase !== 'fenced') corrupt(operation, 'event_payload_violation');
  exactPayloadKeys(operation, payload, ['schemaVersion', 'phase', 'projectId', 'runId', 'attemptId',
    'owner', 'hostInstanceId', 'executionVersion', 'executionStage', 'processIdentity', 'gaps', 'stopConfirmed', 'workspaceReconciled',
    ...(observation ? ['kind', 'observedAtUtcMs', 'evidenceRef'] : [])]);
  try {
    for (const key of ['projectId', 'runId', 'attemptId', 'owner', 'hostInstanceId']) validateStableId(payload[key], { operation }, key);
    if (payload.processIdentity !== null) validateWorkProcessIdentity(payload.processIdentity);
  } catch { corrupt(operation, 'event_payload_violation'); }
  if (!isSafeInteger(payload.executionVersion, 1, Number.MAX_SAFE_INTEGER)
    || !requireEventEnum(payload.executionStage, ATTEMPT_EXECUTION_STAGES)
    || typeof payload.stopConfirmed !== 'boolean' || payload.workspaceReconciled !== false
    || !Array.isArray(payload.gaps) || payload.gaps.length > 32
    || payload.gaps.some(gap => typeof gap !== 'string' || !/^[a-z_]{1,64}$/.test(gap))) corrupt(operation, 'event_payload_violation');
  if ((payload.phase === 'fenced' && payload.stopConfirmed !== false)
    || (payload.stopConfirmed === true && payload.processIdentity === null)
    || (observation && (payload.phase === 'observed') !== (payload.evidenceRef === null))) corrupt(operation, 'event_payload_violation');
  if (observation && (payload.kind !== 'work-startup-recovery'
    || !isSafeInteger(payload.observedAtUtcMs, 0, Number.MAX_SAFE_INTEGER))) corrupt(operation, 'event_payload_violation');
  if (observation && payload.evidenceRef !== null) {
    try { validateStableId(payload.evidenceRef, { operation }, 'evidenceRef'); }
    catch { corrupt(operation, 'event_payload_violation'); }
  }
}

/** 每类事件冻结的 aggregate_type、scope 种类与 payload 形状。 */
export interface StateEventTypeSpec {
  readonly aggregateType: StateEventAggregateType;
  readonly scopeKind: 'project' | 'global';
  readonly payloadKind: EventPayloadKind;
}

export const STATE_EVENT_TYPE_SPECS: Readonly<
  Record<PublicStateEventType, StateEventTypeSpec>
> = Object.freeze({
  'project_profile.confirmed': { aggregateType: 'project_profile', scopeKind: 'project', payloadKind: 'projectProfile' },
  'project_profile.modified': { aggregateType: 'project_profile', scopeKind: 'project', payloadKind: 'projectProfile' },
  'project_profile.rejected': { aggregateType: 'project_profile', scopeKind: 'project', payloadKind: 'projectProfile' },
  [PROJECT_REGISTERED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project',
    scopeKind: 'project',
    payloadKind: 'registered',
  }),
  [PROJECT_REPOSITORY_REBOUND_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project',
    scopeKind: 'project',
    payloadKind: 'repositoryRebound',
  }),
  [PROJECT_METADATA_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project',
    scopeKind: 'project',
    payloadKind: 'changedFields',
  }),
  [SETTINGS_GLOBAL_CREATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'global_settings',
    scopeKind: 'global',
    payloadKind: 'settingsSummary',
  }),
  [SETTINGS_PROJECT_CREATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project_settings',
    scopeKind: 'project',
    payloadKind: 'settingsSummary',
  }),
  [GLOBAL_SETTINGS_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'global_settings',
    scopeKind: 'global',
    payloadKind: 'settingsSummary',
  }),
  [PROJECT_SETTINGS_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project_settings',
    scopeKind: 'project',
    payloadKind: 'settingsSummary',
  }),
  // P02-3 / F-007 §9.2：基线事件白名单扩展（aggregate_type='project'、
  // project_id 非空由既有 v2 CHECK 与映射层共同保证）。
  [BASELINE_AUTHORIZED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project',
    scopeKind: 'project',
    payloadKind: 'baselineAuthorized',
  }),
  [BASELINE_STARTED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project',
    scopeKind: 'project',
    payloadKind: 'baselineStarted',
  }),
  [BASELINE_CHECK_COMPLETED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project',
    scopeKind: 'project',
    payloadKind: 'baselineCheckCompleted',
  }),
  [BASELINE_COMPLETED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project',
    scopeKind: 'project',
    payloadKind: 'baselineCompleted',
  }),
  [BASELINE_CANCELLED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'project',
    scopeKind: 'project',
    payloadKind: 'baselineCancelled',
  }),
  // P03-1 / F-004：Phase 创建事件（聚合为 Phase 自身；project_id 非空由
  // scopeKind='project' 与映射层共同保证，payload 恒为 {created:true}）。
  'phase.delivery.approved': { aggregateType: 'phase', scopeKind: 'project', payloadKind: 'phaseDelivery' },
  'phase.delivery.invalidated': { aggregateType: 'phase', scopeKind: 'project', payloadKind: 'phaseDelivery' },
  'phase.metadata.updated': { aggregateType: 'phase', scopeKind: 'project', payloadKind: 'phaseMutation' },
  'phase.closed': { aggregateType: 'phase', scopeKind: 'project', payloadKind: 'phaseMutation' },
  'phase.reopened': { aggregateType: 'phase', scopeKind: 'project', payloadKind: 'phaseMutation' },
  'phase.archived': { aggregateType: 'phase', scopeKind: 'project', payloadKind: 'phaseMutation' },
  'feature.phase.moved': { aggregateType: 'feature', scopeKind: 'project', payloadKind: 'featurePhaseMoved' },
  [PHASE_CREATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'phase',
    scopeKind: 'project',
    payloadKind: 'phaseCreated',
  }),
  // P03-1 / F-005：Feature 计划导入事件（聚合为导入创建的 Feature 自身；
  // project_id 非空由 scopeKind='project' 与映射层共同保证，payload 恒为
  // {imported:true}，不携带计划正文/策略副本/批准语义）。
  [FEATURE_DAG_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'phase',
    scopeKind: 'project',
    payloadKind: 'featureDagUpdated',
  }),
  [FEATURE_PLAN_IMPORTED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    scopeKind: 'project',
    payloadKind: 'featurePlanImported',
  }),
  // P03-1 / F-007：纯标签 CAS 编辑事件（聚合为目标实体自身；payload 恒为
  // {labelsUpdated:true}，不携带标签正文/批准语义；'task' 聚合随本事件进入白名单）。
  [PHASE_LABELS_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'phase',
    scopeKind: 'project',
    payloadKind: 'planLabelsUpdated',
  }),
  [FEATURE_LABELS_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    scopeKind: 'project',
    payloadKind: 'planLabelsUpdated',
  }),
  [TASK_LABELS_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'task',
    scopeKind: 'project',
    payloadKind: 'planLabelsUpdated',
  }),
  // P03-1 / F-008：实质计划修订事件（聚合为目标 Feature 自身；payload 恒为
  // {revised:true}，不携带计划正文/成员变更明细/批准语义）。
  [FEATURE_PLAN_REVISED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    scopeKind: 'project',
    payloadKind: 'featurePlanRevised',
  }),
  // P03-2 / F-001：Task 策略副本 CAS 编辑事件（聚合为目标 Task 自身；payload
  // 恒为 {strategyUpdated:true}，不携带策略副本正文/凭据引用/批准或执行语义）。
  [TASK_STRATEGY_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'task',
    scopeKind: 'project',
    payloadKind: 'taskStrategyUpdated',
  }),
  // P03-2 / F-002：计划批准事件（聚合为目标 Feature 自身；payload 恒为
  // {approved:true}，不携带计划正文/决策人身份/原因/执行语义）。
  [FEATURE_PLAN_APPROVED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    scopeKind: 'project',
    payloadKind: 'featurePlanApproved',
  }),
  // P03-2 / F-002：计划拒绝事件（聚合为目标 Feature 自身；payload 恒为
  // {rejected:true}，与批准事件可区分，不把拒绝伪装为批准）。
  [FEATURE_PLAN_REJECTED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'feature',
    scopeKind: 'project',
    payloadKind: 'featurePlanRejected',
  }),
  // P03-2 / F-006：执行输入制品组准备完成事件（聚合为目标 Task 自身；
  // payload 恒为 {prepared:true}，准备输入不是启动执行）。
  [EXECUTION_INPUT_PREPARED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'task',
    scopeKind: 'project',
    payloadKind: 'executionInputPrepared',
  }),
  // P03-3 / F-005：执行 Run 派发事件（聚合为派发创建的 Run 自身；payload 恒为
  // {dispatched:true}，不携带预算数值/计划正文/输入正文/启动语义）。
  [EXECUTION_RUN_DISPATCHED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'run',
    scopeKind: 'project',
    payloadKind: 'executionRunDispatched',
  }),
  [EXECUTION_RUN_LABELS_UPDATED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'run',
    scopeKind: 'project',
    payloadKind: 'planLabelsUpdated',
  }),
  [TASK_CLAIMED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'task', scopeKind: 'project', payloadKind: 'taskClaimed',
  }),
  [WORKSPACE_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', scopeKind: 'project', payloadKind: 'workspaceOperationUpdated' }),
  [ATTEMPT_UPDATED_EVENT_TYPE]: Object.freeze({ aggregateType: 'task', scopeKind: 'project', payloadKind: 'attemptUpdated' }),
  [TASK_APPROVAL_BLOCKED_EVENT_TYPE]: Object.freeze({ aggregateType: 'task', scopeKind: 'project', payloadKind: 'taskApprovalBlocked' }),
  [TASK_APPROVAL_DECIDED_EVENT_TYPE]: Object.freeze({ aggregateType: 'task', scopeKind: 'project', payloadKind: 'taskApprovalDecided' }),
  [FEATURE_FINALIZED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', scopeKind: 'project', payloadKind: 'featureFinalized' }),
  [FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', scopeKind: 'project', payloadKind: 'featureFinalizationBlocked' }),
  'work.recovery.updated': Object.freeze({ aggregateType: 'run', scopeKind: 'project', payloadKind: 'workRecovery' }),
  'work.recovery.blocked': Object.freeze({ aggregateType: 'global_settings', scopeKind: 'global', payloadKind: 'workRecovery' }),
  [GIT_OPERATION_REGISTERED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'git_operation', scopeKind: 'project', payloadKind: 'gitOperationRegistered',
  }),
  [GIT_OPERATION_SETTLED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'git_operation', scopeKind: 'project', payloadKind: 'gitOperationSettled',
  }),
  // P03-3 / F-009：批次预算修订事件（聚合为目标 Batch 自身；payload 恒为
  // {revised:true}，不携带预算数值/理由/批准主体/启动或恢复语义）。
  [EXECUTION_BUDGET_REVISED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'execution_batch',
    scopeKind: 'project',
    payloadKind: 'executionBudgetRevised',
  }),
  // P03-9 / F-001：用户暂停意图事件（Run/Batch 各自聚合；payload 恒
  // {paused:true}，不携带预算/deadline/目标正文；暂停不是终态）。
  [EXECUTION_RUN_PAUSED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'run',
    scopeKind: 'project',
    payloadKind: 'executionPaused',
  }),
  [EXECUTION_BATCH_PAUSED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'execution_batch',
    scopeKind: 'project',
    payloadKind: 'executionPaused',
  }),
  // P03-9 / F-002：取消意图/终态事件（payload 恒 {cancelling:true}/{cancelled:true}；
  // cancelling 不是终态，cancelled 只由确认停止/无活动安全路径写入）。
  [EXECUTION_RUN_CANCELLING_EVENT_TYPE]: Object.freeze({
    aggregateType: 'run',
    scopeKind: 'project',
    payloadKind: 'executionCancelling',
  }),
  [EXECUTION_RUN_CANCELLED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'run',
    scopeKind: 'project',
    payloadKind: 'executionCancelled',
  }),
  [EXECUTION_BATCH_CANCELLING_EVENT_TYPE]: Object.freeze({
    aggregateType: 'execution_batch',
    scopeKind: 'project',
    payloadKind: 'executionCancelling',
  }),
  [EXECUTION_BATCH_CANCELLED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'execution_batch',
    scopeKind: 'project',
    payloadKind: 'executionCancelled',
  }),
  // P03-9 / F-008：显式 resume 事件（payload 恒 {resumed:true}；解除暂停不是
  // Runtime 已启动或 Task passed 的证明）。
  [EXECUTION_RUN_RESUMED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'run',
    scopeKind: 'project',
    payloadKind: 'executionResumed',
  }),
  [EXECUTION_BATCH_RESUMED_EVENT_TYPE]: Object.freeze({
    aggregateType: 'execution_batch',
    scopeKind: 'project',
    payloadKind: 'executionResumed',
  }),
  [EXECUTION_FEATURE_PAUSED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', scopeKind: 'project', payloadKind: 'executionPaused' }),
  [EXECUTION_FEATURE_CANCELLING_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', scopeKind: 'project', payloadKind: 'executionCancelling' }),
  [EXECUTION_FEATURE_CANCELLED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', scopeKind: 'project', payloadKind: 'executionCancelled' }),
  [EXECUTION_FEATURE_RESUMED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', scopeKind: 'project', payloadKind: 'executionResumed' }),
});

/** §9.1 公开事件 scope：只有 project/global（命令的 registration scope 不进事件流）。 */
export type PublicEventScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string };

/** §9.1 公开事件封套（线消息形状；只读）。 */
export interface PublicStateEvent {
  readonly schemaVersion: typeof PUBLIC_EVENT_SCHEMA_VERSION;
  /** = state_events.id（UUID v4），客户端去重键。 */
  readonly eventId: string;
  /** = state_events.sequence（持久全局游标；授权过滤后允许跨项目跳跃）。 */
  readonly sequence: number;
  readonly type: PublicStateEventType;
  readonly scope: PublicEventScope;
  readonly aggregate: {
    readonly type: StateEventAggregateType;
    readonly id: string;
    /** 聚合并发计数；与封套 schemaVersion 语义不混用。 */
    readonly revision: number;
  };
  /** ISO UTC（由 occurred_at 毫秒确定性转换）。 */
  readonly occurredAt: string;
  /** 持久脱敏 payload 透传；只允许白名单形状内的键。 */
  readonly payload: Record<string, unknown>;
}

/**
 * state_events 行列在应用侧的形态（由 F-010 读取端口把 snake_case 列映射到
 * 本形态并解析 payload JSON）。本模块只消费该形态，不接触任何数据库驱动。
 */
export interface PersistedStateEventRow {
  readonly id: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateRevision: number;
  readonly projectId: string | null;
  readonly payload: unknown;
  readonly occurredAtUtcMs: number;
}

const PERSISTED_ROW_KEYS = [
  'id',
  'sequence',
  'eventType',
  'aggregateType',
  'aggregateId',
  'aggregateRevision',
  'projectId',
  'payload',
  'occurredAtUtcMs',
] as const;

function corrupt(
  operation: string,
  reason: 'corrupt_event_row' | 'unknown_event_type' | 'event_scope_mismatch' | 'event_payload_violation' | 'corrupt_watermark',
  field?: string,
): never {
  throw new PublicError('corrupt_state', operation, undefined, {
    details: { reason, ...(field !== undefined ? { field } : {}) },
  });
}

function invalidInput(
  operation: string,
  field: string,
  reason: string,
  received?: unknown,
): never {
  throw new PublicError('invalid_input', operation, undefined, {
    details: {
      field,
      reason,
      ...(received !== undefined
        ? { receivedType: received === null ? 'null' : Array.isArray(received) ? 'array' : typeof received }
        : {}),
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  operation: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPrefix = '',
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      invalidInput(operation, `${fieldPrefix}${key}`, 'unknown_field');
    }
  }
}

function isSafeInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function requireNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 脱敏键名（策略键路径/政策段名）：受控字符集，防止控制字符与超长内容进入事件流。 */
const SUMMARY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SUMMARY_LIST_MAX_ENTRIES = 64;

function exactPayloadKeys(
  operation: string,
  payload: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      // 持久 payload 出现白名单外键：只可能是库外篡改/损坏，显式失败，
      // 绝不把可能含值/秘密的未知键透传到公开事件。
      corrupt(operation, 'event_payload_violation');
    }
  }
}

function validateChangedFieldsPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['changedFields']);
  const fields = payload.changedFields;
  if (!Array.isArray(fields) || fields.length === 0) {
    corrupt(operation, 'event_payload_violation');
  }
  const allowed = new Set(['displayName', 'description', 'labels']);
  const seen = new Set<string>();
  for (const field of fields) {
    if (typeof field !== 'string' || !allowed.has(field) || seen.has(field)) {
      corrupt(operation, 'event_payload_violation');
    }
    seen.add(field);
  }
  return { changedFields: [...seen] /* 保持输入顺序 */ };
}

function validateRepositoryReboundPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['rebound', 'previousBindingId', 'bindingId', 'previousBindingRevision', 'bindingRevision']);
  if (payload.rebound !== true || typeof payload.previousBindingId !== 'string' || typeof payload.bindingId !== 'string'
    || !Number.isSafeInteger(payload.previousBindingRevision) || !Number.isSafeInteger(payload.bindingRevision)
    || (payload.previousBindingRevision as number) < 1 || (payload.bindingRevision as number) < 1) {
    corrupt(operation, 'event_payload_violation');
  }
  try {
    validateStableId(payload.previousBindingId, { operation }, 'previousBindingId');
    validateStableId(payload.bindingId, { operation }, 'bindingId');
  } catch {
    corrupt(operation, 'event_payload_violation');
  }
  return {
    rebound: true,
    previousBindingId: payload.previousBindingId,
    bindingId: payload.bindingId,
    previousBindingRevision: payload.previousBindingRevision,
    bindingRevision: payload.bindingRevision,
  };
}

function validateRegisteredPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['registered']);
  if (payload.registered !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { registered: true };
}

/** P03-1 / F-004：Phase 创建事件脱敏 payload（恒为 {created:true}，无业务正文）。 */
function validatePhaseCreatedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['created']);
  if (payload.created !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { created: true };
}

function validateFeaturePlanImportedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['imported']);
  if (payload.imported !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { imported: true };
}

/** P03-1 / F-008：实质计划修订事件脱敏 payload（恒为 {revised:true}，无计划正文）。 */
function validateFeaturePlanRevisedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['revised']);
  if (payload.revised !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { revised: true };
}

/** P03-1 / F-007：纯标签编辑事件脱敏 payload（恒为 {labelsUpdated:true}，无标签正文）。 */
function validatePlanLabelsUpdatedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['labelsUpdated']);
  if (payload.labelsUpdated !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { labelsUpdated: true };
}

/** P03-2 / F-001：Task 策略副本编辑事件脱敏 payload（恒为 {strategyUpdated:true}，无策略正文）。 */
function validateTaskStrategyUpdatedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['strategyUpdated']);
  if (payload.strategyUpdated !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { strategyUpdated: true };
}

/** P03-2 / F-002：计划批准事件脱敏 payload（恒为 {approved:true}，无决策人/原因/计划正文）。 */
function validateFeaturePlanApprovedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['approved']);
  if (payload.approved !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { approved: true };
}

/** P03-2 / F-002：计划拒绝事件脱敏 payload（恒为 {rejected:true}，与批准事件可区分）。 */
function validateFeaturePlanRejectedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['rejected']);
  if (payload.rejected !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { rejected: true };
}

/** P03-2 / F-006：执行输入准备完成事件脱敏 payload（恒 {prepared:true}，无制品/策略/执行语义）。 */
function validateExecutionInputPreparedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['prepared']);
  if (payload.prepared !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { prepared: true };
}

/** P03-3 / F-005：执行 Run 派发事件脱敏 payload（恒 {dispatched:true}，无预算数值/计划/输入/启动语义）。 */
function validateExecutionRunDispatchedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['dispatched']);
  if (payload.dispatched !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { dispatched: true };
}

/** P03-3 / F-009：批次预算修订事件脱敏 payload（恒 {revised:true}，无预算数值/理由/批准主体）。 */
function validateExecutionBudgetRevisedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['revised']);
  if (payload.revised !== true) {
    corrupt(operation, 'event_payload_violation');
  }
  return { revised: true };
}

/** P03-8 / F-002：Git 意图登记事件脱敏 payload（仅 operationId，无路径/消息/身份）。 */
function validateGitOperationRegisteredPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['operationId']);
  if (typeof payload.operationId !== 'string' || !isUuidV4(payload.operationId)) {
    corrupt(operation, 'event_payload_violation');
  }
  return { operationId: payload.operationId };
}

/** P03-8 / F-002：Git 终态事件脱敏 payload（仅 operationId + 受控终态）。 */
function validateGitOperationSettledPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['operationId', 'status']);
  if (
    typeof payload.operationId !== 'string' ||
    !isUuidV4(payload.operationId) ||
    typeof payload.status !== 'string' ||
    !(GIT_OPERATION_TERMINAL_STATUSES as readonly string[]).includes(payload.status)
  ) {
    corrupt(operation, 'event_payload_violation');
  }
  return { operationId: payload.operationId, status: payload.status };
}

function validateSummaryNameList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > SUMMARY_LIST_MAX_ENTRIES) {
    return false;
  }
  return value.every((entry) => typeof entry === 'string' && SUMMARY_NAME_PATTERN.test(entry));
}

function validateSettingsSummaryPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['schemaVersion', 'strategies', 'policies', 'resources']);
  if (payload.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    corrupt(operation, 'event_payload_violation');
  }
  if (!validateSummaryNameList(payload.strategies) || !validateSummaryNameList(payload.policies)) {
    corrupt(operation, 'event_payload_violation');
  }
  let resources: { count: number; digest: string } | undefined;
  if (payload.resources !== undefined) {
    const raw = payload.resources;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) corrupt(operation, 'event_payload_violation');
    const item = raw as Record<string, unknown>;
    exactPayloadKeys(operation, item, ['count', 'digest']);
    if (typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 0 || item.count > 64
      || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)) corrupt(operation, 'event_payload_violation');
    resources = { count: item.count as number, digest: item.digest as string };
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    strategies: [...(payload.strategies as string[])],
    policies: [...(payload.policies as string[])],
    ...(resources === undefined ? {} : { resources }),
  };
}

/* ------------------------------------------------------------------ *
 * §9.2 P02-3 / F-007：基线事件 payload 形状（读取侧，损坏即 corrupt）
 * ------------------------------------------------------------------ */

const EVENT_SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const EVENT_CHECK_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function requireEventUuid(value: unknown): value is string {
  return typeof value === 'string' && isUuidV4(value);
}

function requireEventEnum(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function requireEventReasonCode(
  payload: Record<string, unknown>,
  operation: string,
  required: boolean,
): Record<string, unknown> {
  if (payload.reasonCode === undefined) {
    if (required) {
      corrupt(operation, 'event_payload_violation');
    }
    return {};
  }
  if (!requireEventEnum(payload.reasonCode, BASELINE_REASON_CODES)) {
    corrupt(operation, 'event_payload_violation');
  }
  return { reasonCode: payload.reasonCode };
}

function validateBaselineAuthorizedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['operationId', 'planDigest', 'checkCount']);
  if (
    !requireEventUuid(payload.operationId) ||
    typeof payload.planDigest !== 'string' ||
    !EVENT_SHA256_HEX_PATTERN.test(payload.planDigest) ||
    typeof payload.checkCount !== 'number' ||
    !Number.isSafeInteger(payload.checkCount) ||
    payload.checkCount < BASELINE_CHECKS_MIN ||
    payload.checkCount > BASELINE_CHECKS_MAX
  ) {
    corrupt(operation, 'event_payload_violation');
  }
  return { operationId: payload.operationId, planDigest: payload.planDigest, checkCount: payload.checkCount };
}

function validateBaselineOperationIdPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['operationId']);
  if (!requireEventUuid(payload.operationId)) {
    corrupt(operation, 'event_payload_violation');
  }
  return { operationId: payload.operationId };
}

function validateBaselineCheckCompletedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['operationId', 'checkKey', 'status', 'reasonCode']);
  if (
    !requireEventUuid(payload.operationId) ||
    typeof payload.checkKey !== 'string' ||
    !EVENT_CHECK_KEY_PATTERN.test(payload.checkKey) ||
    !requireEventEnum(payload.status, BASELINE_CHECK_STATUSES)
  ) {
    corrupt(operation, 'event_payload_violation');
  }
  return {
    operationId: payload.operationId,
    checkKey: payload.checkKey,
    status: payload.status,
    ...requireEventReasonCode(payload, operation, false),
  };
}

function validateBaselineSummary(value: unknown, operation: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    corrupt(operation, 'event_payload_violation');
  }
  exactPayloadKeys(operation, value, ['total', 'passed', 'failed', 'error', 'inconclusive', 'notRun']);
  for (const key of ['total', 'passed', 'failed', 'error', 'inconclusive', 'notRun']) {
    const count = value[key];
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > BASELINE_CHECKS_MAX
    ) {
      corrupt(operation, 'event_payload_violation');
    }
  }
  return {
    total: value.total,
    passed: value.passed,
    failed: value.failed,
    error: value.error,
    inconclusive: value.inconclusive,
    notRun: value.notRun,
  };
}

function validateBaselineCompletedPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['operationId', 'status', 'reasonCode', 'summary']);
  if (
    !requireEventUuid(payload.operationId) ||
    !requireEventEnum(payload.status, BASELINE_OPERATION_STATUSES)
  ) {
    corrupt(operation, 'event_payload_violation');
  }
  return {
    operationId: payload.operationId,
    status: payload.status,
    ...requireEventReasonCode(payload, operation, false),
    summary: validateBaselineSummary(payload.summary, operation),
  };
}

function validateBaselineCancelledPayload(
  payload: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  exactPayloadKeys(operation, payload, ['operationId', 'reasonCode']);
  if (!requireEventUuid(payload.operationId)) {
    corrupt(operation, 'event_payload_violation');
  }
  return { operationId: payload.operationId, ...requireEventReasonCode(payload, operation, false) };
}

/**
 * 持久 state_events 行列 → §9.1 公开封套（单向、确定性、无 I/O）。
 *
 * 结构错误 → corrupt_event_row；白名单外类型 → unknown_event_type；
 * type/aggregate/projectId/aggregateId 不一致 → event_scope_mismatch；
 * payload 非对象或形状越界 → event_payload_violation。错误不回显行列原文。
 */
export function mapStateEvent(row: unknown, operation: string = EVENT_READ_OPERATION): PublicStateEvent {
  if (!isPlainObject(row)) {
    corrupt(operation, 'corrupt_event_row');
  }
  for (const key of Object.keys(row)) {
    if (!(PERSISTED_ROW_KEYS as readonly string[]).includes(key)) {
      corrupt(operation, 'corrupt_event_row');
    }
  }
  if (!isUuidV4(row.id)) {
    corrupt(operation, 'corrupt_event_row', 'event.id');
  }
  if (!isSafeInteger(row.sequence, 1, Number.MAX_SAFE_INTEGER)) {
    corrupt(operation, 'corrupt_event_row', 'event.sequence');
  }
  if (!requireNonEmptyString(row.eventType)) {
    corrupt(operation, 'corrupt_event_row', 'event.type');
  }
  if (!requireNonEmptyString(row.aggregateType)) {
    corrupt(operation, 'corrupt_event_row', 'event.aggregate.type');
  }
  if (!requireNonEmptyString(row.aggregateId)) {
    corrupt(operation, 'corrupt_event_row', 'event.aggregate.id');
  }
  if (!isSafeInteger(row.aggregateRevision, 1, Number.MAX_SAFE_INTEGER)) {
    corrupt(operation, 'corrupt_event_row', 'event.aggregate.revision');
  }
  if (row.projectId !== null && !isUuidV4(row.projectId)) {
    corrupt(operation, 'corrupt_event_row', 'event.projectId');
  }
  if (!isSafeInteger(row.occurredAtUtcMs, 0, Number.MAX_SAFE_INTEGER)) {
    corrupt(operation, 'corrupt_event_row', 'event.occurredAt');
  }

  const spec = STATE_EVENT_TYPE_SPECS[row.eventType as PublicStateEventType];
  if (spec === undefined) {
    // 未知持久类型：显式失败，永不伪造/猜测（契约 §9.2 F-003 定案）。
    corrupt(operation, 'unknown_event_type');
  }
  const expectsProject = spec.scopeKind === 'project';
  if (
    spec.aggregateType !== row.aggregateType ||
    (expectsProject ? row.projectId === null : row.projectId !== null)
  ) {
    corrupt(operation, 'event_scope_mismatch');
  }
  if (spec.aggregateType === 'project' && row.aggregateId !== row.projectId) {
    corrupt(operation, 'event_scope_mismatch');
  }
  if (spec.aggregateType === 'global_settings' && row.aggregateId !== GLOBAL_SETTINGS_ID) {
    corrupt(operation, 'event_scope_mismatch');
  }

  if (!isPlainObject(row.payload)) {
    corrupt(operation, 'event_payload_violation');
  }
  let payload: Record<string, unknown>;
  if (spec.payloadKind === 'registered') {
    payload = validateRegisteredPayload(row.payload, operation);
  } else if (spec.payloadKind === 'repositoryRebound') {
    payload = validateRepositoryReboundPayload(row.payload, operation);
  } else if (spec.payloadKind === 'phaseCreated') {
    payload = validatePhaseCreatedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'phaseDelivery') {
    exactPayloadKeys(operation, row.payload, ['schemaVersion', 'approvalId', 'candidateId', 'batchId', 'summaryDigest', 'status', 'reason']);
    if (row.payload.schemaVersion !== 1 || row.payload.status !== (row.eventType === 'phase.delivery.approved' ? 'approved' : 'invalidated')
      || typeof row.payload.summaryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.payload.summaryDigest)
      || (row.payload.reason !== null && typeof row.payload.reason !== 'string')) corrupt(operation, 'event_payload_violation');
    try { for (const key of ['approvalId', 'candidateId', 'batchId']) validateStableId(row.payload[key], { operation }, key); }
    catch { corrupt(operation, 'event_payload_violation'); }
    // Detailed audit bindings remain Core-owned; observation carries no free text.
    payload = { deliveryUpdated: true };
  } else if (spec.payloadKind === 'phaseMutation') {
    const key = {
      'phase.metadata.updated': 'metadataUpdated', 'phase.closed': 'closed',
      'phase.reopened': 'reopened', 'phase.archived': 'archived',
    }[row.eventType as 'phase.metadata.updated' | 'phase.closed' | 'phase.reopened' | 'phase.archived'];
    exactPayloadKeys(operation, row.payload, [key]);
    if (row.payload[key] !== true) corrupt(operation, 'event_payload_violation');
    payload = { [key]: true };
  } else if (spec.payloadKind === 'projectProfile') {
    try { payload = { ...validateProfileAuditPayload(row.payload) }; }
    catch { corrupt(operation, 'event_payload_violation'); }
    if (row.eventType !== `project_profile.${payload.action}` || row.aggregateRevision !== payload.version) corrupt(operation, 'event_payload_violation');
  } else if (spec.payloadKind === 'featurePhaseMoved') {
    exactPayloadKeys(operation, row.payload, ['phaseMoved']);
    if (row.payload.phaseMoved !== true) corrupt(operation, 'event_payload_violation');
    payload = { phaseMoved: true };
  } else if (spec.payloadKind === 'featureDagUpdated') {
    exactPayloadKeys(operation, row.payload, ['dagUpdated']);
    if (row.payload.dagUpdated !== true) corrupt(operation, 'event_payload_violation');
    payload = { dagUpdated: true };
  } else if (spec.payloadKind === 'featurePlanImported') {
    payload = validateFeaturePlanImportedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'planLabelsUpdated') {
    payload = validatePlanLabelsUpdatedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'featurePlanRevised') {
    payload = validateFeaturePlanRevisedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'taskStrategyUpdated') {
    payload = validateTaskStrategyUpdatedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'featurePlanApproved') {
    payload = validateFeaturePlanApprovedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'featurePlanRejected') {
    payload = validateFeaturePlanRejectedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'executionInputPrepared') {
    payload = validateExecutionInputPreparedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'executionRunDispatched') {
    payload = validateExecutionRunDispatchedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'featureFinalized' || spec.payloadKind === 'featureFinalizationBlocked') {
    const key = spec.payloadKind === 'featureFinalized' ? 'finalized' : 'blocked';
    if (Object.keys(row.payload).length !== 1 || row.payload[key] !== true) corrupt(operation, 'event_payload_violation');
    payload = { [key]: true };
  } else if (spec.payloadKind === 'workspaceOperationUpdated') {
    exactPayloadKeys(operation, row.payload, ['schemaVersion', 'operationId', 'status', 'executionStage']);
    if (row.payload.schemaVersion !== 1 || !requireEventEnum(row.payload.status, WORKSPACE_OPERATION_STATUSES)
      || !requireEventEnum(row.payload.executionStage, ATTEMPT_EXECUTION_STAGES)) corrupt(operation, 'event_payload_violation');
    try { validateStableId(row.payload.operationId, { operation }, 'operationId'); }
    catch { corrupt(operation, 'event_payload_violation'); }
    payload = { schemaVersion: 1, operationId: row.payload.operationId, status: row.payload.status, executionStage: row.payload.executionStage };
  } else if (spec.payloadKind === 'attemptUpdated' || spec.payloadKind === 'taskApprovalBlocked' || spec.payloadKind === 'taskApprovalDecided') {
    const key = spec.payloadKind === 'attemptUpdated' ? 'updated' : spec.payloadKind === 'taskApprovalBlocked' ? 'blocked' : 'decided';
    if (Object.keys(row.payload).length !== 1 || row.payload[key] !== true) corrupt(operation, 'event_payload_violation');
    payload = { [key]: true };
  } else if (spec.payloadKind === 'taskClaimed') {
    if (Object.keys(row.payload).length !== 1 || row.payload.claimed !== true) corrupt(operation, 'event_payload_violation');
    payload = { claimed: true };
  } else if (spec.payloadKind === 'executionBudgetRevised') {
    payload = validateExecutionBudgetRevisedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'executionPaused') {
    if (Object.keys(row.payload).length !== 1 || row.payload.paused !== true) corrupt(operation, 'event_payload_violation');
    payload = { paused: true };
  } else if (spec.payloadKind === 'executionResumed') {
    if (Object.keys(row.payload).length !== 1 || row.payload.resumed !== true) corrupt(operation, 'event_payload_violation');
    payload = { resumed: true };
  } else if (spec.payloadKind === 'executionCancelling' || spec.payloadKind === 'executionCancelled') {
    const key = spec.payloadKind === 'executionCancelling' ? 'cancelling' : 'cancelled';
    if (Object.keys(row.payload).length !== 1 || row.payload[key] !== true) corrupt(operation, 'event_payload_violation');
    payload = { [key]: true };
  } else if (spec.payloadKind === 'workRecovery') {
    validateWorkRecoveryPayload(row.payload, operation, row.projectId === null);
    if (row.projectId !== null && row.payload.phase !== 'run_interrupted'
      && (row.payload.projectId !== row.projectId || row.payload.runId !== row.aggregateId)) {
      corrupt(operation, 'event_scope_mismatch');
    }
    // Process identity, owner, evidence contents and workspace facts remain in Core.
    payload = { recoveryUpdated: true };
  } else if (spec.payloadKind === 'gitOperationRegistered') {
    payload = validateGitOperationRegisteredPayload(row.payload, operation);
  } else if (spec.payloadKind === 'gitOperationSettled') {
    payload = validateGitOperationSettledPayload(row.payload, operation);
  } else if (spec.payloadKind === 'changedFields') {
    payload = validateChangedFieldsPayload(row.payload, operation);
  } else if (spec.payloadKind === 'baselineAuthorized') {
    payload = validateBaselineAuthorizedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'baselineStarted') {
    payload = validateBaselineOperationIdPayload(row.payload, operation);
  } else if (spec.payloadKind === 'baselineCheckCompleted') {
    payload = validateBaselineCheckCompletedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'baselineCompleted') {
    payload = validateBaselineCompletedPayload(row.payload, operation);
  } else if (spec.payloadKind === 'baselineCancelled') {
    payload = validateBaselineCancelledPayload(row.payload, operation);
  } else {
    payload = validateSettingsSummaryPayload(row.payload, operation);
  }

  return {
    schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
    eventId: row.id,
    sequence: row.sequence,
    type: row.eventType as PublicStateEventType,
    scope:
      row.projectId === null
        ? { kind: 'global' }
        : { kind: 'project', projectId: row.projectId },
    aggregate: {
      type: row.aggregateType as StateEventAggregateType,
      id: row.aggregateId,
      revision: row.aggregateRevision,
    },
    occurredAt: new Date(row.occurredAtUtcMs).toISOString(),
    payload,
  };
}

/** 批量映射；保持输入顺序（升序由读取侧 SQL ORDER BY sequence 负责，本函数不重排）。 */
export function mapStateEvents(
  rows: readonly unknown[],
  operation: string = EVENT_READ_OPERATION,
): PublicStateEvent[] {
  if (!Array.isArray(rows)) {
    corrupt(operation, 'corrupt_event_row');
  }
  return rows.map((row) => mapStateEvent(row, operation));
}

/* ------------------------------------------------------------------ *
 * §9.3 scope 与游标绑定
 * ------------------------------------------------------------------ */

const EVENT_SCOPE_KEYS = ['kind', 'projectId'] as const;

/**
 * 校验外部事件查询 scope（unknown → 判别联合）。非法形态抛
 * PublicError(invalid_input) 并定位到 scope.* 字段。
 */
export function validateEventScope(
  input: unknown,
  operation: string = EVENT_READ_OPERATION,
): PublicEventScope {
  if (!isPlainObject(input)) {
    invalidInput(operation, 'scope', '必须是 scope 对象', input);
  }
  exactKeys(operation, input, EVENT_SCOPE_KEYS, 'scope.');
  const kind = input.kind;
  if (kind !== 'global' && kind !== 'project') {
    invalidInput(operation, 'scope.kind', "必须是 'global' 或 'project'", kind);
  }
  const hasProjectId = Object.prototype.hasOwnProperty.call(input, 'projectId');
  if (kind === 'project') {
    if (!hasProjectId) {
      invalidInput(operation, 'scope.projectId', 'project scope 必须携带 projectId');
    }
    try {
      return { kind: 'project', projectId: validateStableId(input.projectId, { operation }, 'scope.projectId') };
    } catch (error) {
      if (isStorageError(error, 'validation')) {
        invalidInput(operation, 'scope.projectId', 'invalid_stable_id', input.projectId);
      }
      throw error;
    }
  }
  if (hasProjectId) {
    invalidInput(operation, 'scope.projectId', 'global scope 不允许携带 projectId', input.projectId);
  }
  return { kind: 'global' };
}

const ROOT_IDENTITY_PATTERN = /^[0-9a-f]{64}$/;
const ROOT_FINGERPRINT_LENGTH = 16;

/**
 * 游标签发/解析绑定：数据根身份（P02-1 computeDataRootIdentity：
 * lower_hex(sha256(utf8(realpath 数据根)))）+ 事件 scope。只允许由可信装配
 * 构造，绝不来自请求字段；同一份绑定用于签发与解析。
 */
export interface EventCursorBinding {
  readonly rootIdentity: string;
  readonly scope: PublicEventScope;
}

export function createEventCursorBinding(
  input: unknown,
  operation: string = EVENT_READ_OPERATION,
): EventCursorBinding {
  if (!isPlainObject(input)) {
    invalidInput(operation, 'binding', '必须是对象', input);
  }
  exactKeys(operation, input, ['rootIdentity', 'scope'], 'binding.');
  if (typeof input.rootIdentity !== 'string' || !ROOT_IDENTITY_PATTERN.test(input.rootIdentity)) {
    invalidInput(operation, 'rootIdentity', '必须是 64 位小写十六进制数据根身份', input.rootIdentity);
  }
  return { rootIdentity: input.rootIdentity, scope: validateEventScope(input.scope, operation) };
}

function asBinding(binding: EventCursorBinding): EventCursorBinding {
  if (
    !isPlainObject(binding) ||
    typeof binding.rootIdentity !== 'string' ||
    !ROOT_IDENTITY_PATTERN.test(binding.rootIdentity) ||
    !isPlainObject(binding.scope)
  ) {
    throw new TypeError('EventCursorBinding 形态非法（必须由 createEventCursorBinding 构造）');
  }
  return binding;
}

/** 游标线消息前缀与载荷版本（§9.3）。 */
export const EVENT_CURSOR_PREFIX = 'evcur_v1_';
export const EVENT_CURSOR_VERSION = 1 as const;

/** 根指纹：数据根身份前 16hex（游标不携带完整身份，更不携带路径）。 */
function rootFingerprint(binding: EventCursorBinding): string {
  return binding.rootIdentity.slice(0, ROOT_FINGERPRINT_LENGTH);
}

/** scope 指纹：project 含 projectId；global 为固定域值。 */
function scopeFingerprint(scope: PublicEventScope): string {
  const material =
    scope.kind === 'global'
      ? 'shiploop:event-scope:v1:global'
      : `shiploop:event-scope:v1:project:${scope.projectId}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/** 服务端不变量错误（调用方编程错误；不构造成面向客户端的错误体）。 */
function requireSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('sequence 必须是 0..2^53-1 的安全整数');
  }
  return value;
}

/**
 * 签发不透明续读游标（服务端内部调用）：evcur_v1_<base64url 紧凑 JSON>。
 * seq=0 为空库初始水位；允许远大于当前水位的未来 seq（等待策略由调用方决定）。
 */
export function encodeEventCursor(sequence: number, binding: EventCursorBinding): string {
  const trusted = asBinding(binding);
  const seq = requireSequence(sequence);
  const payload = JSON.stringify({
    v: EVENT_CURSOR_VERSION,
    seq,
    root: rootFingerprint(trusted),
    sk: scopeFingerprint(trusted.scope),
  });
  return `${EVENT_CURSOR_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export interface DecodedEventCursor {
  readonly version: typeof EVENT_CURSOR_VERSION;
  readonly sequence: number;
}

function invalidCursor(operation: string): never {
  invalidInput(operation, 'cursor', 'invalid_cursor');
}

/**
 * 解析并核验客户端回传的游标（unknown → {version,sequence}）。
 *
 * 无法解码/非规范 base64url/非 JSON 对象/未知键/未知版本/seq 负数、小数、
 * 超过安全整数/root 不符/scope 不符，一律 invalid_input(invalid_cursor)，
 * 绝不当作从零读取（契约 §9.3）。本函数不与当前水位比较：未来游标合法。
 */
export function decodeEventCursor(
  cursor: unknown,
  binding: EventCursorBinding,
  operation: string = EVENT_READ_OPERATION,
): DecodedEventCursor {
  const trusted = asBinding(binding);
  if (typeof cursor !== 'string' || !cursor.startsWith(EVENT_CURSOR_PREFIX)) {
    invalidCursor(operation);
  }
  const body = cursor.slice(EVENT_CURSOR_PREFIX.length);
  if (body.length === 0 || !/^[A-Za-z0-9_-]+$/.test(body)) {
    invalidCursor(operation);
  }
  const bytes = Buffer.from(body, 'base64url');
  // 规范编码核验：拒绝填充、尾随数据及一切有歧义的宽容解码。
  if (Buffer.from(bytes).toString('base64url') !== body) {
    invalidCursor(operation);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    invalidCursor(operation);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    invalidCursor(operation);
  }
  if (!isPlainObject(parsed)) {
    invalidCursor(operation);
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'v' && key !== 'seq' && key !== 'root' && key !== 'sk') {
      invalidCursor(operation);
    }
  }
  if (parsed.v !== EVENT_CURSOR_VERSION) {
    invalidCursor(operation);
  }
  if (!isSafeInteger(parsed.seq, 0, Number.MAX_SAFE_INTEGER)) {
    invalidCursor(operation);
  }
  if (
    typeof parsed.root !== 'string' ||
    !/^[0-9a-f]{16}$/.test(parsed.root) ||
    parsed.root !== rootFingerprint(trusted)
  ) {
    invalidCursor(operation);
  }
  if (
    typeof parsed.sk !== 'string' ||
    !/^[0-9a-f]{64}$/.test(parsed.sk) ||
    parsed.sk !== scopeFingerprint(trusted.scope)
  ) {
    invalidCursor(operation);
  }
  return { version: EVENT_CURSOR_VERSION, sequence: parsed.seq };
}

/* ------------------------------------------------------------------ *
 * §8 快照水位与 §9.3 补读分页
 * ------------------------------------------------------------------ */

/** 空库初始水位序列（state_events.sequence 自 1 起，水位 0 表示尚无事件）。 */
export const EVENT_INITIAL_SEQUENCE = 0;

/**
 * 归一化一致读视图内的 MAX(state_events.sequence) 标量：
 * SQL COALESCE 的 null/缺省 → 0；非安全整数视为持久损坏（corrupt_watermark）。
 */
export function normalizeMaxEventSequence(
  value: unknown,
  operation: string = EVENT_READ_OPERATION,
): number {
  if (value === null || value === undefined) {
    return EVENT_INITIAL_SEQUENCE;
  }
  if (!isSafeInteger(value, 0, Number.MAX_SAFE_INTEGER)) {
    corrupt(operation, 'corrupt_watermark');
  }
  return value;
}

/** §8 快照水位：{sequence,cursor}；sequence 必须先经 normalizeMaxEventSequence。 */
export interface EventWatermark {
  readonly sequence: number;
  /** 与数据根身份及查询 scope 绑定的不透明续读游标。 */
  readonly cursor: string;
}

export function createEventWatermark(
  sequence: number,
  binding: EventCursorBinding,
): EventWatermark {
  return { sequence: requireSequence(sequence), cursor: encodeEventCursor(sequence, binding) };
}

/** §9.3/§13 事件补读分页：默认 100、每批最多 500。 */
export const EVENT_PAGE_DEFAULT_LIMIT = 100;
export const EVENT_PAGE_MAX_LIMIT = 500;

/**
 * 校验补读分页 limit（undefined → 默认 100；1..500 整数）；
 * 非法值 invalid_input 定位 limit（不做静默截断）。
 */
export function validateEventPageLimit(
  value: unknown,
  operation: string = EVENT_READ_OPERATION,
): number {
  if (value === undefined) {
    return EVENT_PAGE_DEFAULT_LIMIT;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > EVENT_PAGE_MAX_LIMIT
  ) {
    invalidInput(operation, 'limit', `必须是 1..${EVENT_PAGE_MAX_LIMIT} 的整数`, value);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * F-010 持久事件分页读取窄端口（§9.3 补读分页）
 * ------------------------------------------------------------------ */

/**
 * 持久事件分页读取请求（端口边界形态）：scope 经 validateEventScope 校验，
 * afterSequence 为排他下界（读取 sequence > afterSequence 的已提交事件，
 * 0 = 从持久序列起点读取），limit 经 validateEventPageLimit（1..500）。
 * 实现方按 scope 把可见谓词下推到 SQL（项目流 project_id = ?，全局流
 * project_id IS NULL），按 sequence 升序返回至多 limit 条持久行列；
 * 行列结构/白名单核验由 mapStateEvent 负责（F-003 定案：显式失败）。
 */
export interface StateEventPageRequest {
  readonly scope: PublicEventScope;
  /** 排他下界：0..2^53-1 安全整数（0 表示从起点读取）。 */
  readonly afterSequence: number;
  readonly limit: number;
}

/**
 * 校验分页读取请求（unknown → StateEventPageRequest）：未知键、非法 scope、
 * 非安全整数/负数 afterSequence、非法 limit 一律 invalid_input 并定位字段。
 */
export function validateStateEventPageRequest(
  value: unknown,
  operation: string = EVENT_READ_OPERATION,
): StateEventPageRequest {
  if (!isPlainObject(value)) {
    invalidInput(operation, 'request', '必须是对象', value);
  }
  exactKeys(operation, value, ['scope', 'afterSequence', 'limit'], 'request.');
  if (!isSafeInteger(value.afterSequence, 0, Number.MAX_SAFE_INTEGER)) {
    invalidInput(operation, 'afterSequence', '必须是 0..2^53-1 的安全整数', value.afterSequence);
  }
  return {
    scope: validateEventScope(value.scope, operation),
    afterSequence: value.afterSequence,
    limit: validateEventPageLimit(value.limit, operation),
  };
}

/**
 * Last-Event-ID 恢复位置解析请求（端口边界形态）：eventId 必须在给定授权
 * scope 内解析为持久 sequence；scope 校验与分页读取同一规则。
 */
export interface StateEventSequenceLookupRequest {
  readonly scope: PublicEventScope;
  /** 客户端持有的 SSE 帧 id（= state_events.id，UUID v4）。 */
  readonly eventId: string;
}

/**
 * 校验恢复位置解析请求（unknown → StateEventSequenceLookupRequest）：未知键、
 * 非法 scope、非 UUID v4 的 eventId 一律 invalid_input 并定位字段。
 */
export function validateStateEventSequenceLookup(
  value: unknown,
  operation: string = EVENT_READ_OPERATION,
): StateEventSequenceLookupRequest {
  if (!isPlainObject(value)) {
    invalidInput(operation, 'request', '必须是对象', value);
  }
  exactKeys(operation, value, ['scope', 'eventId'], 'request.');
  if (typeof value.eventId !== 'string' || !isUuidV4(value.eventId)) {
    invalidInput(operation, 'eventId', 'invalid_event_id', value.eventId);
  }
  return {
    scope: validateEventScope(value.scope, operation),
    eventId: value.eventId,
  };
}

/**
 * 持久 state_events 分页读取窄端口（F-010）与 Last-Event-ID 解析（F-012）：
 * 唯一事件来源是持久审计表，内存通知/日志不得充当事件正文。只暴露应用侧
 * 行列形态/sequence 标量，不泄漏驱动会话。
 *
 * findPersistedEventSequence 仅在请求 scope 谓词内查找 eventId：找不到
 * （不存在或属于其他 scope）一律 undefined，不区分两种情形（防存在性探测）；
 * 命中行的 sequence 损坏视为持久损坏（corrupt）。
 */
export interface StateEventReadStore {
  listPersistedEvents(request: unknown): readonly PersistedStateEventRow[];
  /** F-012：在授权 scope 内把 SSE Last-Event-ID 解析为持久 sequence。 */
  findPersistedEventSequence(request: unknown): number | undefined;
}
