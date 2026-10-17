/**
 * P03-8 / F-002 受控提交意图与 Git 操作回执（端口契约，迁移 v26）。
 *
 * 设计依据：input/p03-feature-delivery.md FR-1（执行前固定意图、执行后核对
 * tree/HEAD 再落回执；commit 已发生但回执丢失按父/tree/意图核对，不盲重复
 * 提交；无变更是明确 no_change，不捏造 commit）、core-design/07 §4（提交作为
 * operation：保存预期 HEAD、代码摘要、消息和策略→执行 git→核对新 HEAD/tree→
 * 回执落库）与 core-design/11 §9（operations：外部副作用的恢复意图与回执）。
 *
 * 本任务只交付**持久化与原子写入能力**，不执行 Git、不读取文件系统、不等待
 * 审批（F-003 执行受控提交，F-004 核对不确定副作用，F-009/F-010 查询，
 * F-008 命令通道）。因此：
 * - 意图注册是不可变事实：operationId、Project/Feature/Run/适用 Attempt、
 *   executionVersion、规范仓库/worktree 身份、预期 HEAD、候选 tree、代码摘要、
 *   验证/审批引用、消息、用户身份、策略摘要、runtime 审计与执行归属一次固定，
 *   后续 UPDATE 只允许写回终态事实（actual commit/tree、退出/耗时、回执、
 *   deliveryStatus、settled_at、revision/updated_at）；触发器作为防御纵深；
 * - 未固定意图不得触发 Git 写入：终态写回要求既有 pending 意图；调用方
 *   （F-003）必须先从本端口读取 pending 意图，才能执行 Git；
 * - 同一 operationId + 相同意图幂等返回原记录；不同意图复用 ID → conflict
 *   （details.reason='intent_conflict'）；跨项目/跨 Feature/Run/Attempt 关联、
 *   陈旧 Feature revision 与 executionVersion 一律结构化拒绝；
 * - 终态写回是单一 CAS：状态、actual commit/tree、操作回执、Feature 的
 *   deliveryStatus 与 `state_events` 在同一 BEGIN IMMEDIATE 内落库；任一步失败
 *   整组回滚，不产生“只有成功事件或回执而没有权威状态”的记录；
 * - 未知退出码/耗时保持 null，不以 0 填充；`unknown` 终态不携带 actual
 *   commit/tree（无法断言的结果不能冒充事实）；
 * - 本模块是纯契约：只做确定性校验与摘要计算，不读时钟/文件系统/网络/数据库，
 *   不导入 Git、SDK、HTTP 或 ORM。
 */
import { createHash } from 'node:crypto';
import {
  validateConfirmedGitIdentity,
  validateRuntimeSourceAuditRecord,
  type ConfirmedGitIdentity,
  type RuntimeSourceAuditRecord,
} from './delivery-policy.js';
import { StorageError } from './errors.js';
import { stableStringify } from './feature-plan.js';
import type { CommandTransaction } from './atomic-commands.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateExpectedRevision,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
  type ValidationContext,
} from './validation.js';

/** 本版本唯一支持的操作类型：Feature 最终提交（Task 不自行提交，F-001 政策）。 */
export const GIT_OPERATION_TYPE_FEATURE_FINAL_COMMIT = 'feature_final_commit';

/** 意图身份摘要的领域前缀（与计划/检查/交付政策摘要域隔离）。 */
export const GIT_OPERATION_INTENT_DIGEST_DOMAIN = 'shiploop:git-operation-intent:v1';

/** 操作回执 schema 版本（冻结 v1）。 */
export const GIT_OPERATION_RECEIPT_SCHEMA_VERSION = 1;

/** 操作生命周期（pending 为唯一非终态；未知结果必须显式 unknown）。 */
export const GIT_OPERATION_STATUSES = [
  'pending',
  'succeeded',
  'no_change',
  'failed',
  'unknown',
] as const;
export type GitOperationStatus = (typeof GIT_OPERATION_STATUSES)[number];

/** 可写回终态（pending 不是终态）。 */
export const GIT_OPERATION_TERMINAL_STATUSES = [
  'succeeded',
  'no_change',
  'failed',
  'unknown',
] as const;
export type GitOperationTerminalStatus = (typeof GIT_OPERATION_TERMINAL_STATUSES)[number];

/**
 * Feature 交付状态（设计 02 §交付状态：not_requested/pending/succeeded/failed）。
 * no_change 属于操作终态，不扩展 deliveryStatus 枚举；查询按操作状态区分。
 */
export const FEATURE_DELIVERY_STATUSES = [
  'not_requested',
  'pending',
  'succeeded',
  'failed',
] as const;
export type FeatureDeliveryStatus = (typeof FEATURE_DELIVERY_STATUSES)[number];

/** 证据引用种类（验证批次、计划审批、人工审批、制品等既有身份）。 */
export const GIT_OPERATION_EVIDENCE_KINDS = [
  'verification_batch',
  'verification_result',
  'plan_approval',
  'human_approval',
  'artifact',
] as const;
export type GitOperationEvidenceKind = (typeof GIT_OPERATION_EVIDENCE_KINDS)[number];

export const GIT_OPERATION_EVIDENCE_MAX_COUNT = 32;
export const GIT_COMMIT_MESSAGE_MAX_CODE_POINTS = 4_096;
export const GIT_OPERATION_REASON_CODE_MAX_LENGTH = 64;
export const GIT_REPOSITORY_IDENTITY_MAX_LENGTH = 512;
export const GIT_WORKTREE_PATH_MAX_LENGTH = 4_096;
export const GIT_OWNER_MAX_LENGTH = 128;
export const GIT_HOST_INSTANCE_MAX_LENGTH = 128;

/** 退出码上限（进程退出码按无符号 32 位安全整数；未知保持 null）。 */
const GIT_EXIT_CODE_MAX = 2_147_483_647;
const GIT_DURATION_MAX_MS = Number.MAX_SAFE_INTEGER;

const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/;

/** 验证/审批引用：稳定身份 + 绑定摘要（摘要漂移使引用失效）。 */
export interface GitOperationEvidenceRef {
  readonly kind: GitOperationEvidenceKind;
  readonly id: string;
  readonly digest: string;
}

/** 不可变提交意图（注册成功后不得改写）。 */
export interface GitOperationIntent {
  readonly operationId: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  /** 适用 Attempt（Feature 最终提交通常为空；按 Task 提交策略时提供）。 */
  readonly attemptId: string | null;
  /** 执行代次（Attempt 存在时必须等于 attempts.execution_version）。 */
  readonly executionVersion: number;
  readonly operationType: typeof GIT_OPERATION_TYPE_FEATURE_FINAL_COMMIT;
  readonly repositoryBindingId: string;
  /** 稳定本地仓库身份（repoIdentity；remote 不参与）。 */
  readonly repoIdentity: string;
  /** realpath 规范化后的 worktree 路径（F-003 执行前再次核对）。 */
  readonly worktreePath: string;
  /** 预期 HEAD（提交前固定；外部漂移暂停而非 reset）。 */
  readonly expectedHead: string;
  /** 候选 tree（提交前固定的暂存结果身份）。 */
  readonly candidateTree: string;
  /** 候选源码摘要（sha256；验证证据绑定的代码身份）。 */
  readonly codeDigest: string;
  /** 有效验证引用（至少绑定身份与摘要；有效性由调用方在事务外核验）。 */
  readonly verificationRefs: readonly GitOperationEvidenceRef[];
  /** 有效审批引用（可为空：政策不要求人审时）。 */
  readonly approvalRefs: readonly GitOperationEvidenceRef[];
  readonly message: string;
  /** 用户明确配置并确认的提交身份（不回落开发机全局身份）。 */
  readonly gitIdentity: ConfirmedGitIdentity;
  /** 冻结的交付政策身份摘要（F-001 computeDeliveryPolicyDigest）。 */
  readonly deliveryPolicyDigest: string;
  /** Runtime/provider/model 独立审计（可为空；与 Git 身份分离）。 */
  readonly runtimeSource: RuntimeSourceAuditRecord | null;
  /** 执行归属（owner/host 身份；不携带凭据）。 */
  readonly ownerId: string;
  readonly hostInstanceId: string;
}

/** 注册输入 = 意图 + 注册时的 Feature revision 前置条件（不进入意图摘要）。 */
export interface GitOperationRegisterInput extends GitOperationIntent {
  readonly expectedFeatureRevision: number;
}

/** Git 操作回执（终态事实的权威应用侧形态；与操作行同事务落库）。 */
export interface GitOperationReceipt {
  readonly schemaVersion: typeof GIT_OPERATION_RECEIPT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly status: GitOperationTerminalStatus;
  readonly intentDigest: string;
  readonly expectedHead: string;
  readonly candidateTree: string;
  readonly actualCommit: string | null;
  readonly actualTree: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly reasonCode: string | null;
  readonly deliveryStatus: FeatureDeliveryStatus;
  readonly recordedAtUtcMs: number;
}

/** 终态写回输入（CAS 于 expectedRevision）。 */
export interface GitOperationFinalizeInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly status: GitOperationTerminalStatus;
  readonly actualCommit: string | null;
  readonly actualTree: string | null;
  /** 未知退出码保持 null，不填 0。 */
  readonly exitCode: number | null;
  /** 未知耗时保持 null，不填 0。 */
  readonly durationMs: number | null;
  readonly reasonCode: string | null;
  readonly deliveryStatus: FeatureDeliveryStatus;
  readonly settledAtUtcMs: number;
}

/** 持久化记录（与 git_operations 表逐列对应）。 */
export interface GitOperationRecord {
  readonly intent: GitOperationIntent;
  readonly intentDigest: string;
  readonly status: GitOperationStatus;
  readonly actualCommit: string | null;
  readonly actualTree: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly reasonCode: string | null;
  readonly receipt: GitOperationReceipt | null;
  readonly deliveryStatus: FeatureDeliveryStatus | null;
  readonly settledAtUtcMs: number | null;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

/** 注册结果：created=false 表示同 operationId 同意图幂等重放。 */
export interface GitOperationMutation {
  readonly operation: GitOperationRecord;
  readonly created: boolean;
}

/** 终态写回结果：settled=false 表示同终态事实幂等重放（不再写事件）。 */
export interface GitOperationFinalization {
  readonly operation: GitOperationRecord;
  readonly settled: boolean;
}

/** 端口：应用服务使用（内部经原子命令端口提交）。 */
export interface GitOperationStore {
  registerGitOperation(input: unknown): GitOperationMutation;
  finalizeGitOperation(input: unknown): GitOperationFinalization;
  getGitOperation(projectId: string, operationId: string): GitOperationRecord;
  findGitOperationsByIntentDigest(
    projectId: string,
    featureId: string,
    intentDigest: string,
  ): readonly GitOperationRecord[];
  registerGitOperationInTransaction(
    transaction: CommandTransaction,
    input: unknown,
  ): GitOperationMutation;
  finalizeGitOperationInTransaction(
    transaction: CommandTransaction,
    input: unknown,
  ): GitOperationFinalization;
  getGitOperationInTransaction(
    transaction: CommandTransaction,
    projectId: string,
    operationId: string,
  ): GitOperationRecord;
}

const REGISTER_KEYS = [
  'operationId',
  'projectId',
  'featureId',
  'runId',
  'attemptId',
  'executionVersion',
  'operationType',
  'repositoryBindingId',
  'repoIdentity',
  'worktreePath',
  'expectedHead',
  'candidateTree',
  'codeDigest',
  'verificationRefs',
  'approvalRefs',
  'message',
  'gitIdentity',
  'deliveryPolicyDigest',
  'runtimeSource',
  'ownerId',
  'hostInstanceId',
  'expectedFeatureRevision',
] as const;

const FINALIZE_KEYS = [
  'operationId',
  'projectId',
  'expectedRevision',
  'status',
  'actualCommit',
  'actualTree',
  'exitCode',
  'durationMs',
  'reasonCode',
  'deliveryStatus',
  'settledAtUtcMs',
] as const;

const EVIDENCE_KEYS = ['kind', 'id', 'digest'] as const;

function codePointLength(value: string): number {
  return [...value].length;
}

function validateGitOid(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !GIT_OID_PATTERN.test(value)) {
    throw validationError(context, field, '必须是 40 或 64 位小写十六进制 Git 对象 ID', value);
  }
  return value;
}

function validateOptionalGitOid(
  value: unknown,
  context: ValidationContext,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return validateGitOid(value, context, field);
}

function validateBoundedText(
  value: unknown,
  context: ValidationContext,
  field: string,
  maxCodePoints: number,
): string {
  const text = requireNonEmptyString(value, context, field);
  if (codePointLength(text) > maxCodePoints || CONTROL_PATTERN.test(text)) {
    throw validationError(context, field, `必须是 1..${maxCodePoints} 码点且不含控制字符`);
  }
  return text;
}

/** 规范 worktree 路径：绝对、无 NUL/控制字符、无 `.`/`..` 段、不以 `/` 结尾。 */
function validateWorktreePath(value: unknown, context: ValidationContext, field: string): string {
  const text = requireNonEmptyString(value, context, field);
  if (
    codePointLength(text) > GIT_WORKTREE_PATH_MAX_LENGTH ||
    CONTROL_PATTERN.test(text) ||
    !text.startsWith('/') ||
    (text.length > 1 && text.endsWith('/'))
  ) {
    throw validationError(context, field, '必须是绝对、规范化的 worktree 路径');
  }
  const segments = text.split('/');
  if (segments.includes('.') || segments.includes('..')) {
    throw validationError(context, field, '路径不得包含 `.` 或 `..` 段');
  }
  return text;
}

function validateOwnerText(
  value: unknown,
  context: ValidationContext,
  field: string,
  maxCodePoints: number,
): string {
  const text = requireNonEmptyString(value, context, field);
  if (codePointLength(text) > maxCodePoints || /[\u0000-\u001F\u007F\s]/.test(text)) {
    throw validationError(context, field, '必须是 1..128 码点且不含空白/控制字符');
  }
  return text;
}

function validateMessage(value: unknown, context: ValidationContext, field: string): string {
  const text = requireNonEmptyString(value, context, field);
  if (codePointLength(text) > GIT_COMMIT_MESSAGE_MAX_CODE_POINTS || CONTROL_PATTERN.test(text)) {
    throw validationError(
      context,
      field,
      `提交消息必须是 1..${GIT_COMMIT_MESSAGE_MAX_CODE_POINTS} 码点且不含控制字符（允许换行）`,
    );
  }
  return text;
}

function validateReasonCode(
  value: unknown,
  context: ValidationContext,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !REASON_CODE_PATTERN.test(value)) {
    throw validationError(context, field, '必须是 null 或 [a-z][a-z0-9_]{0,63} 形式的受控原因码', value);
  }
  return value;
}

function validateEvidenceRefs(
  value: unknown,
  context: ValidationContext,
  field: string,
): readonly GitOperationEvidenceRef[] {
  if (!Array.isArray(value)) {
    throw validationError(context, field, '必须是证据引用数组', value);
  }
  if (value.length > GIT_OPERATION_EVIDENCE_MAX_COUNT) {
    throw validationError(context, field, `最多 ${GIT_OPERATION_EVIDENCE_MAX_COUNT} 条引用`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const entryField = `${field}[${index}]`;
    const object = requirePlainObject(entry, context, entryField);
    rejectUnknownKeys(object, EVIDENCE_KEYS, context, entryField);
    if (
      typeof object.kind !== 'string' ||
      !(GIT_OPERATION_EVIDENCE_KINDS as readonly string[]).includes(object.kind)
    ) {
      throw validationError(
        context,
        `${entryField}.kind`,
        `必须是 ${GIT_OPERATION_EVIDENCE_KINDS.join('/')} 之一`,
        object.kind,
      );
    }
    const id = validateStableId(object.id, context, `${entryField}.id`);
    const digest = validateSha256Digest(object.digest, context, `${entryField}.digest`);
    const key = `${object.kind}\u0000${id}\u0000${digest}`;
    if (seen.has(key)) {
      throw validationError(context, entryField, '重复的证据引用（同一 kind/id/digest）');
    }
    seen.add(key);
    return { kind: object.kind as GitOperationEvidenceKind, id, digest };
  });
}

function normalizeRuntimeSource(
  value: unknown,
  context: ValidationContext,
): RuntimeSourceAuditRecord | null {
  if (value === undefined || value === null) {
    return null;
  }
  return validateRuntimeSourceAuditRecord(value, context, 'runtimeSource');
}

/** 规范化后的意图身份摘要（稳定 JSON + SHA-256；不含时间戳/前置 revision）。 */
export function computeGitOperationIntentDigest(intent: GitOperationIntent): string {
  return createHash('sha256')
    .update(
      stableStringify({
        domain: GIT_OPERATION_INTENT_DIGEST_DOMAIN,
        operationId: intent.operationId,
        projectId: intent.projectId,
        featureId: intent.featureId,
        runId: intent.runId,
        attemptId: intent.attemptId,
        executionVersion: intent.executionVersion,
        operationType: intent.operationType,
        repositoryBindingId: intent.repositoryBindingId,
        repoIdentity: intent.repoIdentity,
        worktreePath: intent.worktreePath,
        expectedHead: intent.expectedHead,
        candidateTree: intent.candidateTree,
        codeDigest: intent.codeDigest,
        verificationRefs: intent.verificationRefs,
        approvalRefs: intent.approvalRefs,
        message: intent.message,
        gitIdentity: intent.gitIdentity,
        deliveryPolicyDigest: intent.deliveryPolicyDigest,
        runtimeSource: intent.runtimeSource,
        ownerId: intent.ownerId,
        hostInstanceId: intent.hostInstanceId,
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * 注册输入校验（端口边界；先于任何 SQL）。未知字段、非法 OID/摘要/身份/路径、
 * 未知操作类型、非正 revision/version、重复证据引用均拒绝。
 */
export function validateGitOperationRegisterInput(
  value: unknown,
  operation = 'GitOperationStore.register',
): GitOperationRegisterInput {
  const context: ValidationContext = { operation, entity: { type: 'git_operation' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, REGISTER_KEYS, context, 'input');

  const operationId = validateStableId(object.operationId, context, 'operationId');
  const projectId = validateStableId(object.projectId, context, 'projectId');
  const featureId = validateStableId(object.featureId, context, 'featureId');
  const runId = validateStableId(object.runId, context, 'runId');
  const attemptId =
    object.attemptId === undefined || object.attemptId === null
      ? null
      : validateStableId(object.attemptId, context, 'attemptId');
  const executionVersion = validatePositiveInteger(object.executionVersion, context, 'executionVersion');
  if (object.operationType !== GIT_OPERATION_TYPE_FEATURE_FINAL_COMMIT) {
    throw validationError(
      context,
      'operationType',
      `本版本仅支持 ${GIT_OPERATION_TYPE_FEATURE_FINAL_COMMIT}`,
      object.operationType,
    );
  }
  const repositoryBindingId = validateStableId(
    object.repositoryBindingId,
    context,
    'repositoryBindingId',
  );
  const repoIdentity = validateBoundedText(
    object.repoIdentity,
    context,
    'repoIdentity',
    GIT_REPOSITORY_IDENTITY_MAX_LENGTH,
  );
  const worktreePath = validateWorktreePath(object.worktreePath, context, 'worktreePath');
  const expectedHead = validateGitOid(object.expectedHead, context, 'expectedHead');
  const candidateTree = validateGitOid(object.candidateTree, context, 'candidateTree');
  const codeDigest = validateSha256Digest(object.codeDigest, context, 'codeDigest');
  const verificationRefs = validateEvidenceRefs(object.verificationRefs, context, 'verificationRefs');
  const approvalRefs = validateEvidenceRefs(object.approvalRefs, context, 'approvalRefs');
  const message = validateMessage(object.message, context, 'message');
  const gitIdentity = validateConfirmedGitIdentity(object.gitIdentity, context, 'gitIdentity');
  const deliveryPolicyDigest = validateSha256Digest(
    object.deliveryPolicyDigest,
    context,
    'deliveryPolicyDigest',
  );
  const runtimeSource = normalizeRuntimeSource(object.runtimeSource, context);
  const ownerId = validateOwnerText(object.ownerId, context, 'ownerId', GIT_OWNER_MAX_LENGTH);
  const hostInstanceId = validateOwnerText(
    object.hostInstanceId,
    context,
    'hostInstanceId',
    GIT_HOST_INSTANCE_MAX_LENGTH,
  );
  const expectedFeatureRevision = validatePositiveInteger(
    object.expectedFeatureRevision,
    context,
    'expectedFeatureRevision',
  );

  return {
    operationId,
    projectId,
    featureId,
    runId,
    attemptId,
    executionVersion,
    operationType: GIT_OPERATION_TYPE_FEATURE_FINAL_COMMIT,
    repositoryBindingId,
    repoIdentity,
    worktreePath,
    expectedHead,
    candidateTree,
    codeDigest,
    verificationRefs,
    approvalRefs,
    message,
    gitIdentity,
    deliveryPolicyDigest,
    runtimeSource,
    ownerId,
    hostInstanceId,
    expectedFeatureRevision,
  };
}

/**
 * 终态写回输入校验。终态形态在端口层冻结：
 * - succeeded：actualCommit/actualTree 必填且 actualTree = candidateTree；
 * - no_change：actualCommit = expectedHead、actualTree 必填；
 * - unknown：actualCommit/actualTree 必须为 null（未知不能冒充事实）；
 * - failed：actual 字段可空（可能已提交但 hook 失败/核对未完成）；
 * - succeeded/no_change → deliveryStatus='succeeded'；failed → 'failed'；
 *   unknown → 'pending'（待核对，不显示成功）。
 */
export function validateGitOperationFinalizeInput(
  value: unknown,
  operation = 'GitOperationStore.finalize',
): GitOperationFinalizeInput {
  const context: ValidationContext = { operation, entity: { type: 'git_operation' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, FINALIZE_KEYS, context, 'input');

  const operationId = validateStableId(object.operationId, context, 'operationId');
  const projectId = validateStableId(object.projectId, context, 'projectId');
  const expectedRevision = validateExpectedRevision(object.expectedRevision, context);
  if (
    typeof object.status !== 'string' ||
    !(GIT_OPERATION_TERMINAL_STATUSES as readonly string[]).includes(object.status)
  ) {
    throw validationError(
      context,
      'status',
      `必须是 ${GIT_OPERATION_TERMINAL_STATUSES.join('/')} 之一（pending 不是终态）`,
      object.status,
    );
  }
  const status = object.status as GitOperationTerminalStatus;
  const actualCommit = validateOptionalGitOid(object.actualCommit, context, 'actualCommit');
  const actualTree = validateOptionalGitOid(object.actualTree, context, 'actualTree');
  const exitCode =
    object.exitCode === undefined || object.exitCode === null
      ? null
      : validateNonNegativeInteger(object.exitCode, context, 'exitCode');
  if (exitCode !== null && exitCode > GIT_EXIT_CODE_MAX) {
    throw validationError(context, 'exitCode', `不得超过 ${GIT_EXIT_CODE_MAX}`);
  }
  const durationMs =
    object.durationMs === undefined || object.durationMs === null
      ? null
      : validateNonNegativeInteger(object.durationMs, context, 'durationMs');
  if (durationMs !== null && durationMs > GIT_DURATION_MAX_MS) {
    throw validationError(context, 'durationMs', '必须是安全非负整数');
  }
  const reasonCode = validateReasonCode(object.reasonCode, context, 'reasonCode');
  if (
    typeof object.deliveryStatus !== 'string' ||
    !(FEATURE_DELIVERY_STATUSES as readonly string[]).includes(object.deliveryStatus)
  ) {
    throw validationError(
      context,
      'deliveryStatus',
      `必须是 ${FEATURE_DELIVERY_STATUSES.join('/')} 之一`,
      object.deliveryStatus,
    );
  }
  const deliveryStatus = object.deliveryStatus as FeatureDeliveryStatus;
  const settledAtUtcMs = validateNonNegativeInteger(object.settledAtUtcMs, context, 'settledAtUtcMs');

  if (status === 'succeeded') {
    if (actualCommit === null || actualTree === null) {
      throw validationError(context, 'actualCommit', 'succeeded 必须携带 actualCommit 与 actualTree');
    }
    if (deliveryStatus !== 'succeeded') {
      throw validationError(context, 'deliveryStatus', "succeeded 的 deliveryStatus 必须是 'succeeded'");
    }
  } else if (status === 'no_change') {
    if (actualCommit === null || actualTree === null) {
      throw validationError(context, 'actualCommit', 'no_change 必须携带实际 HEAD 与 tree');
    }
    if (deliveryStatus !== 'succeeded') {
      throw validationError(context, 'deliveryStatus', "no_change 的 deliveryStatus 必须是 'succeeded'");
    }
  } else if (status === 'unknown') {
    if (actualCommit !== null || actualTree !== null) {
      throw validationError(
        context,
        'actualCommit',
        'unknown 终态不得携带 actualCommit/actualTree（未知结果不能冒充事实）',
      );
    }
    if (deliveryStatus !== 'pending') {
      throw validationError(context, 'deliveryStatus', "unknown 的 deliveryStatus 必须是 'pending'（待核对）");
    }
  } else if (deliveryStatus !== 'failed') {
    throw validationError(context, 'deliveryStatus', "failed 的 deliveryStatus 必须是 'failed'");
  }

  return {
    operationId,
    projectId,
    expectedRevision,
    status,
    actualCommit,
    actualTree,
    exitCode,
    durationMs,
    reasonCode,
    deliveryStatus,
    settledAtUtcMs,
  };
}

/** 终态与意图的固有关系（succeeded tree 必须等于候选 tree；no_change HEAD 不变）。 */
function assertTerminalMatchesIntent(
  intent: GitOperationIntent,
  input: GitOperationFinalizeInput,
  operation: string,
): void {
  if (input.status === 'succeeded' && input.actualTree !== intent.candidateTree) {
    throw new StorageError('conflict', operation, 'succeeded actualTree must equal the fixed candidateTree', {
      entity: { type: 'git_operation', id: intent.operationId, projectId: intent.projectId },
      details: { reason: 'candidate_tree_mismatch' },
    });
  }
  if (input.status === 'no_change' && input.actualCommit !== intent.expectedHead) {
    throw new StorageError('conflict', operation, 'no_change actualCommit must equal the fixed expectedHead', {
      entity: { type: 'git_operation', id: intent.operationId, projectId: intent.projectId },
      details: { reason: 'expected_head_mismatch' },
    });
  }
}

/** 由规范化事实构造回执（终态写回与读取映射共用）。 */
export function buildGitOperationReceipt(
  intent: GitOperationIntent,
  intentDigest: string,
  input: GitOperationFinalizeInput,
): GitOperationReceipt {
  return {
    schemaVersion: GIT_OPERATION_RECEIPT_SCHEMA_VERSION,
    operationId: intent.operationId,
    status: input.status,
    intentDigest,
    expectedHead: intent.expectedHead,
    candidateTree: intent.candidateTree,
    actualCommit: input.actualCommit,
    actualTree: input.actualTree,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    reasonCode: input.reasonCode,
    deliveryStatus: input.deliveryStatus,
    recordedAtUtcMs: input.settledAtUtcMs,
  };
}

function validateReceiptShape(
  value: unknown,
  context: ValidationContext,
): GitOperationReceipt {
  const object = requirePlainObject(value, context, 'receipt');
  rejectUnknownKeys(
    object,
    [
      'schemaVersion',
      'operationId',
      'status',
      'intentDigest',
      'expectedHead',
      'candidateTree',
      'actualCommit',
      'actualTree',
      'exitCode',
      'durationMs',
      'reasonCode',
      'deliveryStatus',
      'recordedAtUtcMs',
    ],
    context,
    'receipt',
  );
  if (object.schemaVersion !== GIT_OPERATION_RECEIPT_SCHEMA_VERSION) {
    throw validationError(context, 'receipt.schemaVersion', `必须是 ${GIT_OPERATION_RECEIPT_SCHEMA_VERSION}`);
  }
  if (
    typeof object.status !== 'string' ||
    !(GIT_OPERATION_TERMINAL_STATUSES as readonly string[]).includes(object.status)
  ) {
    throw validationError(context, 'receipt.status', '必须是终态');
  }
  const operationId = validateStableId(object.operationId, context, 'receipt.operationId');
  const intentDigest = validateSha256Digest(object.intentDigest, context, 'receipt.intentDigest');
  const expectedHead = validateGitOid(object.expectedHead, context, 'receipt.expectedHead');
  const candidateTree = validateGitOid(object.candidateTree, context, 'receipt.candidateTree');
  const actualCommit = validateOptionalGitOid(object.actualCommit, context, 'receipt.actualCommit');
  const actualTree = validateOptionalGitOid(object.actualTree, context, 'receipt.actualTree');
  const exitCode =
    object.exitCode === null
      ? null
      : validateNonNegativeInteger(object.exitCode, context, 'receipt.exitCode');
  const durationMs =
    object.durationMs === null
      ? null
      : validateNonNegativeInteger(object.durationMs, context, 'receipt.durationMs');
  const reasonCode = validateReasonCode(object.reasonCode, context, 'receipt.reasonCode');
  if (
    typeof object.deliveryStatus !== 'string' ||
    !(FEATURE_DELIVERY_STATUSES as readonly string[]).includes(object.deliveryStatus)
  ) {
    throw validationError(context, 'receipt.deliveryStatus', '必须是 Feature 交付状态');
  }
  const recordedAtUtcMs = validateNonNegativeInteger(
    object.recordedAtUtcMs,
    context,
    'receipt.recordedAtUtcMs',
  );
  return {
    schemaVersion: GIT_OPERATION_RECEIPT_SCHEMA_VERSION,
    operationId,
    status: object.status as GitOperationTerminalStatus,
    intentDigest,
    expectedHead,
    candidateTree,
    actualCommit,
    actualTree,
    exitCode,
    durationMs,
    reasonCode,
    deliveryStatus: object.deliveryStatus as FeatureDeliveryStatus,
    recordedAtUtcMs,
  };
}

/**
 * 持久记录复核（适配器读取映射使用；损坏即 corrupt，不作为有效记录返回）。
 * 同时重算意图摘要，检测被篡改的意图列。
 */
export function validateGitOperationRecord(
  value: unknown,
  operation = 'GitOperationStore.read',
): GitOperationRecord {
  const context: ValidationContext = { operation, entity: { type: 'git_operation' } };
  const object = requirePlainObject(value, context, 'record');
  rejectUnknownKeys(
    object,
    [
      'intent',
      'intentDigest',
      'status',
      'actualCommit',
      'actualTree',
      'exitCode',
      'durationMs',
      'reasonCode',
      'receipt',
      'deliveryStatus',
      'settledAtUtcMs',
      'revision',
      'createdAtUtcMs',
      'updatedAtUtcMs',
    ],
    context,
    'record',
  );
  const intent = validateGitOperationRegisterInput(
    { ...requirePlainObject(object.intent, context, 'intent'), expectedFeatureRevision: 1 },
    operation,
  );
  const normalizedIntent = stripPrecondition(intent);
  const intentDigest = validateSha256Digest(object.intentDigest, context, 'intentDigest');
  if (computeGitOperationIntentDigest(normalizedIntent) !== intentDigest) {
    throw validationError(context, 'intentDigest', '与固定意图内容不一致（疑似篡改）');
  }
  if (
    typeof object.status !== 'string' ||
    !(GIT_OPERATION_STATUSES as readonly string[]).includes(object.status)
  ) {
    throw validationError(context, 'status', '必须是受控操作状态');
  }
  const status = object.status as GitOperationStatus;
  const revision = validatePositiveInteger(object.revision, context, 'revision');
  const createdAtUtcMs = validateNonNegativeInteger(object.createdAtUtcMs, context, 'createdAtUtcMs');
  const updatedAtUtcMs = validateNonNegativeInteger(object.updatedAtUtcMs, context, 'updatedAtUtcMs');
  const actualCommit = validateOptionalGitOid(object.actualCommit, context, 'actualCommit');
  const actualTree = validateOptionalGitOid(object.actualTree, context, 'actualTree');
  const exitCode =
    object.exitCode === undefined || object.exitCode === null
      ? null
      : validateNonNegativeInteger(object.exitCode, context, 'exitCode');
  const durationMs =
    object.durationMs === undefined || object.durationMs === null
      ? null
      : validateNonNegativeInteger(object.durationMs, context, 'durationMs');
  const reasonCode = validateReasonCode(object.reasonCode, context, 'reasonCode');
  const settledAtUtcMs =
    object.settledAtUtcMs === undefined || object.settledAtUtcMs === null
      ? null
      : validateNonNegativeInteger(object.settledAtUtcMs, context, 'settledAtUtcMs');
  const deliveryStatus =
    object.deliveryStatus === undefined || object.deliveryStatus === null
      ? null
      : typeof object.deliveryStatus === 'string' &&
          (FEATURE_DELIVERY_STATUSES as readonly string[]).includes(object.deliveryStatus)
        ? (object.deliveryStatus as FeatureDeliveryStatus)
        : (() => {
            throw validationError(context, 'deliveryStatus', '必须是受控交付状态');
          })();
  const receipt =
    object.receipt === undefined || object.receipt === null
      ? null
      : validateReceiptShape(object.receipt, context);

  if (status === 'pending') {
    if (
      actualCommit !== null ||
      actualTree !== null ||
      exitCode !== null ||
      durationMs !== null ||
      reasonCode !== null ||
      receipt !== null ||
      deliveryStatus !== null ||
      settledAtUtcMs !== null
    ) {
      throw validationError(context, 'status', 'pending 不得携带终态事实/回执/deliveryStatus');
    }
  } else {
    if (receipt === null || deliveryStatus === null || settledAtUtcMs === null) {
      throw validationError(context, 'receipt', '终态必须携带回执、deliveryStatus 与 settledAt');
    }
    if (
      receipt.operationId !== normalizedIntent.operationId ||
      receipt.status !== status ||
      receipt.intentDigest !== intentDigest ||
      receipt.expectedHead !== normalizedIntent.expectedHead ||
      receipt.candidateTree !== normalizedIntent.candidateTree ||
      receipt.actualCommit !== actualCommit ||
      receipt.actualTree !== actualTree ||
      receipt.exitCode !== exitCode ||
      receipt.durationMs !== durationMs ||
      receipt.reasonCode !== reasonCode ||
      receipt.deliveryStatus !== deliveryStatus ||
      receipt.recordedAtUtcMs !== settledAtUtcMs
    ) {
      throw validationError(context, 'receipt', '回执与操作行事实不一致');
    }
  }

  return {
    intent: normalizedIntent,
    intentDigest,
    status,
    actualCommit,
    actualTree,
    exitCode,
    durationMs,
    reasonCode,
    receipt,
    deliveryStatus,
    settledAtUtcMs,
    revision,
    createdAtUtcMs,
    updatedAtUtcMs,
  };
}

/** 去掉注册前置条件，得到纯意图（摘要与记录共用）。 */
export function stripPrecondition(input: GitOperationRegisterInput): GitOperationIntent {
  const { expectedFeatureRevision: _ignored, ...intent } = input;
  void _ignored;
  return intent;
}

/**
 * 同 operationId 的重放判定（纯函数）：完全相同的意图 → 幂等；任一意图字段
 * 不同 → conflict（intent_conflict），既有记录不变。
 */
export function isSameGitOperationIntent(
  existing: GitOperationRecord,
  candidate: GitOperationIntent,
): boolean {
  return computeGitOperationIntentDigest(existing.intent) === computeGitOperationIntentDigest(candidate);
}

/** 终态重放判定（相同事实幂等；不同事实 conflict）。 */
export function isSameGitOperationFinalization(
  existing: GitOperationRecord,
  input: GitOperationFinalizeInput,
): boolean {
  return (
    existing.status === input.status &&
    existing.actualCommit === input.actualCommit &&
    existing.actualTree === input.actualTree &&
    existing.exitCode === input.exitCode &&
    existing.durationMs === input.durationMs &&
    existing.reasonCode === input.reasonCode &&
    existing.deliveryStatus === input.deliveryStatus &&
    existing.settledAtUtcMs === input.settledAtUtcMs
  );
}

/** 终态与意图固有关系（适配器在写事务内调用）。 */
export function assertFinalizationMatchesIntent(
  intent: GitOperationIntent,
  input: GitOperationFinalizeInput,
  operation = 'GitOperationStore.finalize',
): void {
  assertTerminalMatchesIntent(intent, input, operation);
}
