/**
 * P05-1 / F-005 planning Run 派发与原子认领窄契约（ports 契约层：类型、常量
 * 与纯校验/纯派生；无 I/O、无时钟、无数据库、无模型调用）。
 *
 * 设计依据：input/p05-planning.md FR-4（plan 与同项目编码排他；恢复不重复导入；
 * 派发按 Run purpose 路由）、core-design/04 §2（原子认领：一次提交创建 Attempt、
 * 递增 executionVersion、记账预占并保存认领回执；事务外才允许 Runtime 启动）、
 * §3（planning Task 使用已确认的规划输入版本，不要求业务计划批准；规划 Task 不
 * 进入编码 DAG 调度）、core-design/15 §2/§3（复用 Run 持久派发队列、Run 级认领、
 * 单执行槽位与资源记录；生产容量 1；租约到期只触发核对不重新分配写入者）。
 * 实施约束：现有 claimTask 明确只接收 kind=coding——本契约新增 planning 分支，
 * 具备独立前置校验（规划上下文/规划输入/策略副本/权限面），不是删除编码审批
 * 检查后的复用；不开放 P05-4/5 的多 Feature 并发门控与额度。
 *
 * 契约要点：
 * - **planning Attempt 输入快照**（PlanningAttemptInputSnapshot）是与编码
 *   PreparedExecutionInputGroup 判别的独立制品组身份：同一 F-004 三正文
 *   （snapshot/manifest/prompt，planning 专用 kind）+ 必需输入引用 + 六摘要组
 *   （含 codeBaselineDigest）；**不携带任何业务计划批准身份**（approval/
 *   decisionId/checkPolicyDigest 不存在——规划授权由 planning.start 回执与
 *   规划上下文承担，不伪造 plan approval）。持久形态满足 attempts 表 DDL
 *   （schemaVersion∈{1,2,3}、projectId/featureId/taskId、digests.snapshotDigest、
 *   group.snapshot.artifactId 与列一致；三正文与必需输入逐条对应 ready 制品）。
 * - **认领输入**（PlanningClaimInput）：与编码 TaskClaimInput 同族（claimKey 幂等、
 *   owner/hostInstanceId、expectedRevision/executionVersion CAS、可信工作区令牌、
 *   租约上限、launch 身份），但快照是 planning 判别形态，且无返工/恢复身份
 *   （首次规划认领只允许 planning Task 仍 pending 且无历史 Attempt）。
 * - **认领回执**复用 TaskClaimReceipt 结构（dispatch 归属 + Attempt + 预占 +
 *   三组资源租约 + 计数 + 事件 + launch）：历史重放是证据，绝不是再次启动的
 *   授权；旧 owner/executionVersion 的结果或释放请求不能覆盖当前执行。
 * - 错误纪律：复用 StorageError kind='validation'/'conflict'（details.reason 取
 *   PLANNING_CLAIM_REJECTION_REASONS 受控词汇；eligibility 携带 not_ready 细分）。
 *
 * 本契约不实现：SQLite 事务原语（adapters/sqlite/planning-claim-store.ts）、
 * 调度器路由（application/work-scheduler.ts + application/planning-dispatch.ts）、
 * 候选提交通道（F-006）、Runtime 执行（F-007）、取消/超时结算（F-009）。
 */
import type { PreparedPlanningInputGroup } from './planning-input-prepare.js';
import type { ExecutionInputRef } from './execution-input.js';
import { validateExecutionInputRef } from './execution-input.js';
import type { VerifiedWorkWorkspace } from './work-resources.js';
import type { TaskClaimReceipt, TaskClaimResult } from './task-claim.js';
import { validateTaskClaimDispatch, validateTaskClaimLaunch } from './task-claim.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validateArtifactLocator,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 常量与受控词汇
 * ------------------------------------------------------------------ */

/** planning 认领操作名（StorageError.operation 与调度诊断使用）。 */
export const PLANNING_CLAIM_OPERATION = 'PlanningClaim.claimPlanningTask' as const;

/** planning Attempt 输入快照结构版本（与编码快照共用 DDL 版本域 {1,2,3}）。 */
export const PLANNING_CLAIM_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** planning 快照判别标记（编码快照无该键；编码校验按未知键拒绝该键）。 */
export const PLANNING_CLAIM_SNAPSHOT_PURPOSE = 'planning' as const;

/** planning 认领租约缺省时长（毫秒；与编码 DISPATCH_LEASE_MS 同量级）。 */
export const PLANNING_CLAIM_LEASE_MS_DEFAULT = 60_000 as const;

/**
 * planning 认领拒绝原因（details.reason 受控词汇）：
 * - claim_key_reused：同 claimKey 异请求摘要（幂等身份冲突）；
 * - stale_task：Task revision/executionVersion CAS 失败（含 fencing 已推进）；
 * - not_ready：details.eligibility 细分（run/batch 控制阻塞、上下文/Task 状态、
 *   输入/策略/权限/目标漂移、归属不一致、历史 Attempt 存在等）；
 * - budget_exhausted：deadline/尝试/Runtime 启动额度耗尽；
 * - resource_busy：项目 Work 排他（workspace 租约/基线占用）；
 * - counter_overflow / lease_exceeds_deadline / claim_constraint：防御性失败。
 */
export const PLANNING_CLAIM_REJECTION_REASONS = [
  'claim_key_reused',
  'stale_task',
  'not_ready',
  'budget_exhausted',
  'resource_busy',
  'counter_overflow',
  'lease_exceeds_deadline',
  'claim_constraint',
] as const;
export type PlanningClaimRejectionReason = (typeof PLANNING_CLAIM_REJECTION_REASONS)[number];

/** not_ready 细分（details.eligibility；有界枚举，不是第二套状态机）。 */
export const PLANNING_CLAIM_ELIGIBILITY_REASONS = [
  'run_control_blocked',
  'batch_control_blocked',
  'project_not_active',
  'phase_not_open',
  'feature_terminal',
  'feature_plan_drift',
  'task_outside_scope',
  'planning_context_not_open',
  'planning_task_not_pending',
  'planning_attempt_history_present',
  'planning_identity_mismatch',
  'input_digest_mismatch',
  'input_identity_changed',
  'required_inputs_changed',
  'input_artifact_changed',
  'strategy_copy_changed',
  'permissions_changed',
] as const;
export type PlanningClaimEligibilityReason = (typeof PLANNING_CLAIM_ELIGIBILITY_REASONS)[number];

/* ------------------------------------------------------------------ *
 * planning Attempt 输入快照（持久形态）
 * ------------------------------------------------------------------ */

/**
 * planning Attempt 的冻结输入身份（attempts.input_snapshot 的 planning 形态）。
 *
 * 与编码 PreparedExecutionInputGroup 判别：携带 purpose='planning' 判别键与
 * candidateId/runId/phaseId 规划身份；六摘要组在编码五摘要之上增加
 * codeBaselineDigest（F-004 代码基线内容身份）。**不携带**业务计划批准身份
 * （approval/decisionId/checkPolicyDigest）与返工/恢复/回退身份——这些编码
 * 专属键在本形态下恒为不存在（`?: undefined` 同时是类型层文档：规划 Attempt
 * 永远不携带它们）。
 */
export interface PlanningAttemptInputSnapshot {
  readonly schemaVersion: typeof PLANNING_CLAIM_SNAPSHOT_SCHEMA_VERSION;
  readonly purpose: typeof PLANNING_CLAIM_SNAPSHOT_PURPOSE;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly runId: string;
  /** planning Task 身份（DDL 要求与 attempts.task_id 一致）。 */
  readonly taskId: string;
  readonly candidateId: string;
  readonly group: {
    readonly snapshot: PlanningClaimBodyRef;
    readonly manifest: PlanningClaimBodyRef;
    readonly prompt: PlanningClaimBodyRef;
  };
  readonly requiredInputs: readonly ExecutionInputRef[];
  readonly digests: {
    readonly snapshotDigest: string;
    readonly manifestDigest: string;
    readonly promptDigest: string;
    readonly strategyCopyDigest: string;
    readonly permissionsDigest: string;
    readonly codeBaselineDigest: string;
  };
  readonly preparedAtUtcMs: number;
  /** 编码专属身份在 planning 快照中恒不存在（判别文档，不持久化该键）。 */
  readonly approval?: undefined;
  readonly taskRevision?: undefined;
  readonly promptBytes?: undefined;
  readonly tokenEstimate?: undefined;
  readonly rework?: undefined;
  readonly recovery?: undefined;
  readonly runtimeFallback?: undefined;
}

/** 制品组单正文引用（与编码 ExecutionInputGroupBodyRef 同形）。 */
export interface PlanningClaimBodyRef {
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly mediaType: string;
}

const SNAPSHOT_KEYS = [
  'schemaVersion', 'purpose', 'projectId', 'phaseId', 'featureId', 'runId', 'taskId',
  'candidateId', 'group', 'requiredInputs', 'digests', 'preparedAtUtcMs',
  // 编码专属键：读取侧允许缺席（undefined/null），出现即拒绝（判别失败）。
  'approval', 'taskRevision', 'promptBytes', 'tokenEstimate', 'rework', 'recovery', 'runtimeFallback',
] as const;

const CONTEXT_KEYS = { operation: PLANNING_CLAIM_OPERATION };

function bodyRef(value: unknown, context: ValidationContext, field: string): PlanningClaimBodyRef {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, ['artifactId', 'version', 'contentHash', 'sizeBytes', 'locator', 'mediaType'], context, field);
  const mediaType = raw.mediaType;
  if (typeof mediaType !== 'string' || mediaType.length === 0 || mediaType.length > 128 || /[\0-\x1f\x7f]/.test(mediaType)) {
    throw validationError(context, `${field}.mediaType`, 'invalid_bounded_text', mediaType);
  }
  return {
    artifactId: validateStableId(raw.artifactId, context, `${field}.artifactId`),
    version: validatePositiveInteger(raw.version, context, `${field}.version`),
    contentHash: validateSha256Digest(raw.contentHash, context, `${field}.contentHash`),
    sizeBytes: (() => {
      if (!Number.isSafeInteger(raw.sizeBytes) || Number(raw.sizeBytes) < 0) {
        throw validationError(context, `${field}.sizeBytes`, 'invalid_safe_integer', raw.sizeBytes);
      }
      return Number(raw.sizeBytes);
    })(),
    locator: validateArtifactLocator(raw.locator, context, `${field}.locator`),
    mediaType,
  };
}

/**
 * 校验 planning Attempt 输入快照（写入与读取两侧共用；未知键一律拒绝，
 * 编码专属键出现即拒绝）。返回全新独立对象（不与输入共享引用）。
 */
export function validatePlanningAttemptInputSnapshot(value: unknown): PlanningAttemptInputSnapshot {
  const context: ValidationContext = { ...CONTEXT_KEYS, entity: { type: 'attempt' } };
  const raw = requirePlainObject(value, context, 'inputSnapshot');
  rejectUnknownKeys(raw, [...SNAPSHOT_KEYS], context, 'inputSnapshot');
  for (const codingOnly of ['approval', 'taskRevision', 'promptBytes', 'tokenEstimate', 'rework', 'recovery', 'runtimeFallback'] as const) {
    if (raw[codingOnly] !== undefined && raw[codingOnly] !== null) {
      throw validationError(context, `inputSnapshot.${codingOnly}`, 'planning_snapshot_must_not_carry_coding_identity', raw[codingOnly]);
    }
  }
  if (raw.schemaVersion !== PLANNING_CLAIM_SNAPSHOT_SCHEMA_VERSION) {
    throw validationError(context, 'inputSnapshot.schemaVersion', 'unsupported_schema_version', raw.schemaVersion);
  }
  if (raw.purpose !== PLANNING_CLAIM_SNAPSHOT_PURPOSE) {
    throw validationError(context, 'inputSnapshot.purpose', 'must_be_planning', raw.purpose);
  }
  const group = requirePlainObject(raw.group, context, 'inputSnapshot.group');
  rejectUnknownKeys(group, ['snapshot', 'manifest', 'prompt'], context, 'inputSnapshot.group');
  const digests = requirePlainObject(raw.digests, context, 'inputSnapshot.digests');
  rejectUnknownKeys(digests, ['snapshotDigest', 'manifestDigest', 'promptDigest', 'strategyCopyDigest', 'permissionsDigest', 'codeBaselineDigest'], context, 'inputSnapshot.digests');
  if (!Array.isArray(raw.requiredInputs) || raw.requiredInputs.length > 256) {
    throw validationError(context, 'inputSnapshot.requiredInputs', 'invalid_bounded_array');
  }
  const requiredInputs = raw.requiredInputs.map((ref, index) =>
    validateExecutionInputRef(ref, `${PLANNING_CLAIM_OPERATION}[requiredInput:${index}]`));
  const snapshot: PlanningAttemptInputSnapshot = {
    schemaVersion: PLANNING_CLAIM_SNAPSHOT_SCHEMA_VERSION,
    purpose: PLANNING_CLAIM_SNAPSHOT_PURPOSE,
    projectId: validateStableId(raw.projectId, context, 'inputSnapshot.projectId'),
    phaseId: validateStableId(raw.phaseId, context, 'inputSnapshot.phaseId'),
    featureId: validateStableId(raw.featureId, context, 'inputSnapshot.featureId'),
    runId: validateStableId(raw.runId, context, 'inputSnapshot.runId'),
    taskId: validateStableId(raw.taskId, context, 'inputSnapshot.taskId'),
    candidateId: validateStableId(raw.candidateId, context, 'inputSnapshot.candidateId'),
    group: {
      snapshot: bodyRef(group.snapshot, context, 'inputSnapshot.group.snapshot'),
      manifest: bodyRef(group.manifest, context, 'inputSnapshot.group.manifest'),
      prompt: bodyRef(group.prompt, context, 'inputSnapshot.group.prompt'),
    },
    requiredInputs,
    digests: {
      snapshotDigest: validateSha256Digest(digests.snapshotDigest, context, 'inputSnapshot.digests.snapshotDigest'),
      manifestDigest: validateSha256Digest(digests.manifestDigest, context, 'inputSnapshot.digests.manifestDigest'),
      promptDigest: validateSha256Digest(digests.promptDigest, context, 'inputSnapshot.digests.promptDigest'),
      strategyCopyDigest: validateSha256Digest(digests.strategyCopyDigest, context, 'inputSnapshot.digests.strategyCopyDigest'),
      permissionsDigest: validateSha256Digest(digests.permissionsDigest, context, 'inputSnapshot.digests.permissionsDigest'),
      codeBaselineDigest: validateSha256Digest(digests.codeBaselineDigest, context, 'inputSnapshot.digests.codeBaselineDigest'),
    },
    preparedAtUtcMs: (() => {
      if (!Number.isSafeInteger(raw.preparedAtUtcMs) || Number(raw.preparedAtUtcMs) < 0) {
        throw validationError(context, 'inputSnapshot.preparedAtUtcMs', 'invalid_safe_integer', raw.preparedAtUtcMs);
      }
      return Number(raw.preparedAtUtcMs);
    })(),
  };
  if (snapshot.requiredInputs.some(ref => ref.projectId !== snapshot.projectId)) {
    throw validationError(context, 'inputSnapshot.requiredInputs', 'project_mismatch');
  }
  return snapshot;
}

/**
 * 从 F-004 已准备规划输入组派生 planning Attempt 输入快照（纯函数；planningTaskId
 * 投影为 taskId 以满足 attempts DDL 身份一致性）。
 */
export function buildPlanningAttemptInputSnapshot(
  prepared: PreparedPlanningInputGroup,
): PlanningAttemptInputSnapshot {
  return validatePlanningAttemptInputSnapshot({
    schemaVersion: PLANNING_CLAIM_SNAPSHOT_SCHEMA_VERSION,
    purpose: PLANNING_CLAIM_SNAPSHOT_PURPOSE,
    projectId: prepared.projectId,
    phaseId: prepared.phaseId,
    featureId: prepared.featureId,
    runId: prepared.runId,
    taskId: prepared.planningTaskId,
    candidateId: prepared.candidateId,
    group: {
      snapshot: { ...prepared.group.snapshot },
      manifest: { ...prepared.group.manifest },
      prompt: { ...prepared.group.prompt },
    },
    requiredInputs: prepared.requiredInputs.map(ref => ({ ...ref, origin: ref.origin })),
    digests: { ...prepared.digests },
    preparedAtUtcMs: prepared.preparedAtUtcMs,
  });
}

/* ------------------------------------------------------------------ *
 * 认领输入与端口
 * ------------------------------------------------------------------ */

/** planning 原子认领输入（与编码 TaskClaimInput 同族；快照为 planning 判别形态）。 */
export interface PlanningClaimInput {
  readonly claimKey: string;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly expectedRevision: number;
  readonly executionVersion: number;
  readonly workspace: VerifiedWorkWorkspace;
  readonly leaseUntilUtcMs: number;
  readonly inputSnapshot: PlanningAttemptInputSnapshot;
  /** F-003：准备阶段冻结的 Core launch 身份；回执原样保留。 */
  readonly launch?: {
    readonly sessionId: string;
    readonly invocationId: string;
    readonly parentSessionId?: string | null;
  };
  /** 已准备派发身份（可选；提供时必须与当前归属一致）。 */
  readonly dispatch?: ReturnType<typeof validateTaskClaimDispatch>;
}

/** planning 原子认领存储端口（一次调用=一次已提交的短写事务）。 */
export interface PlanningClaimStore {
  /** Returns only after committing its own short synchronous write transaction. */
  claimPlanningTask(input: unknown): TaskClaimResult;
}

export type { TaskClaimReceipt, TaskClaimResult };

/** 校验 planning 认领输入（未知键一律拒绝；工作区令牌由可信权威查验）。 */
export function validatePlanningClaimInput(
  value: unknown,
  inspectWorkspace: (token: unknown) => VerifiedWorkWorkspace,
): PlanningClaimInput {
  const context: ValidationContext = { ...CONTEXT_KEYS, entity: { type: 'task' } };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['claimKey', 'projectId', 'runId', 'taskId', 'owner', 'hostInstanceId',
    'expectedRevision', 'executionVersion', 'workspace', 'leaseUntilUtcMs', 'inputSnapshot', 'launch', 'dispatch'], context, 'input');
  const integer = (key: string, minimum: number): number => {
    const n = raw[key];
    if (!Number.isSafeInteger(n) || Number(n) < minimum || Number(n) >= Number.MAX_SAFE_INTEGER) {
      throw validationError(context, key, 'invalid_safe_integer', n);
    }
    return Number(n);
  };
  const launch = raw.launch === undefined || raw.launch === null
    ? undefined : validateTaskClaimLaunch(raw.launch, context, 'launch');
  return {
    claimKey: validateStableId(raw.claimKey, context, 'claimKey'),
    projectId: validateStableId(raw.projectId, context, 'projectId'),
    runId: validateStableId(raw.runId, context, 'runId'),
    taskId: validateStableId(raw.taskId, context, 'taskId'),
    owner: validateStableId(raw.owner, context, 'owner'),
    hostInstanceId: validateStableId(raw.hostInstanceId, context, 'hostInstanceId'),
    expectedRevision: integer('expectedRevision', 1),
    executionVersion: integer('executionVersion', 0),
    workspace: inspectWorkspace(raw.workspace),
    leaseUntilUtcMs: integer('leaseUntilUtcMs', 1),
    inputSnapshot: validatePlanningAttemptInputSnapshot(raw.inputSnapshot),
    ...(raw.dispatch === undefined ? {} : { dispatch: validateTaskClaimDispatch(raw.dispatch) }),
    ...(launch === undefined ? {} : { launch }),
  };
}
