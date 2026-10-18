/**
 * P03-9 / F-007 同 Task 通用续接决策与来源快照（ports 契约层：类型、常量、
 * 结构化错误与纯校验函数，无任何 I/O）。
 *
 * 设计依据：core-design/14-runtime-recovery-and-durable.md §2/§3/§4（恢复
 * 选择 auto/new/required、来源身份、恢复记录进入 Attempt input_snapshot、
 * 当前策略重新核验、预算不重置）、core-design/04-scheduling-and-recovery.md
 * （停止是所有模式的共同前提）与 input/p03-run-control.md FR-2。
 *
 * 契约要点：
 * - 候选历史只允许同 Project/Feature/Task 的直接上一 Attempt；来源 Attempt
 *   必须已停止、无遗留占用、并经过 P03-9 / F-006 恢复现场核对（reconciled），
 *   `new` 也不是绕过占用或停止核验的通道；
 * - 每次允许继续生成新 Attempt 时，本记录构成其不可变输入的一部分：请求
 *   模式、实际决策、原因、来源 Attempt/Session、当前完整策略副本、工作区
 *   身份、恢复现场证据引用与必需输入引用全部固定；旧输入/来源档案不被改写；
 * - 安全的新 Session 只携带精简恢复交接（上一 Attempt 状态/结束时间/诊断
 *   引用与必需输入引用），不内联完整原生历史，不创建/重置预算或启动 Runtime；
 * - 复用 P03-3A conversation/checkpoint 与 nativeHistory/conversationResume/
 *   executionRecovery/modelSwitchOnResume/nativeFork 能力词汇；auto 降级是
 *   显式记录，required 未支持明确拒绝；
 * - 来源一律是同项目不可变 Artifact 身份，绝不携带原生路径；未知字段、
 *   跨项目/跨 Task 来源、自相矛盾的决策在进入适配器前拒绝。
 *
 * 实现者：application/work-recovery-continuation.ts（决策、现场核对与快照
 * 发布）；本层不实现 Pi SDK resume、不打开原生库、不写预算/占用。
 */
import { validateExecutionInputRef } from './execution-input.js';
import type { ExecutionInputRef } from './execution-input.js';
import {
  validateRuntimeRecoveryDecision,
  validateRuntimeRecoveryReference,
  validateRuntimeRecoverySelection,
} from './runtime-recovery.js';
import type {
  RuntimeRecoveryDecision,
  RuntimeRecoveryReference,
  RuntimeRecoverySelection,
} from './runtime-recovery.js';
import { validateRuntimeStrategy } from './settings-schema.js';
import type { RuntimeStrategyV1 } from './settings-schema.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION = 1;
export const WORK_RECOVERY_CONTINUATION_ARTIFACT_KIND = 'work-recovery-continuation';
export const WORK_RECOVERY_CONTINUATION_MEDIA_TYPE = 'application/json';
export const WORK_RECOVERY_CONTINUATION_LOCATOR_PREFIX = 'work-recovery-continuations';

const context: ValidationContext = { operation: 'WorkRecoveryContinuation' };

export type WorkRecoveryContinuationFailureReason =
  | 'candidate_missing'
  | 'candidate_identity_mismatch'
  | 'previous_active'
  | 'occupancy_unresolved'
  | 'reconciliation_missing'
  | 'reconciliation_unsafe'
  | 'source_invalid'
  | 'input_changed'
  | 'policy_changed'
  | 'capability_unsupported';

/** Structured, non-leaking failure owned by this contract (never a Runtime start). */
export class WorkRecoveryContinuationError extends Error {
  readonly reason: WorkRecoveryContinuationFailureReason;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    reason: WorkRecoveryContinuationFailureReason,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(`WorkRecoveryContinuation: ${message}`);
    this.name = 'WorkRecoveryContinuationError';
    this.reason = reason;
    this.details = details;
  }
}

export function isWorkRecoveryContinuationError(
  value: unknown,
  reason?: WorkRecoveryContinuationFailureReason,
): value is WorkRecoveryContinuationError {
  return value instanceof WorkRecoveryContinuationError
    && (reason === undefined || value.reason === reason);
}

/** Current, fully authorized policy fixed into the new Attempt input. */
export interface WorkRecoveryPolicySnapshot {
  readonly executionConfig: Readonly<Record<string, unknown>>;
  readonly configSource: string;
  readonly configSourceKey: string | null;
  readonly permissionsDigest: string;
  readonly checkPolicyDigest: string;
  readonly taskRevision: number;
}

/** Same-Task workspace identity rechecked before any continuation. */
export interface WorkRecoveryWorkspaceFacts {
  readonly workspaceId: string;
  readonly repositoryIdentity: string;
  readonly branch: string;
  readonly headCommit: string;
  readonly codeDigest: string;
}

/** Compact handoff: never a full native history or an inlined input body. */
export interface WorkRecoveryHandoff {
  readonly previousAttemptId: string;
  readonly previousStatus: string;
  readonly previousExecutionStage: string;
  readonly previousEndedAtUtcMs: number | null;
  readonly previousErrorKind: string | null;
  readonly previousDiagnosticRef: string | null;
  readonly codeRef: string | null;
  readonly requiredInputRefs: readonly ExecutionInputRef[];
  readonly note: string;
}

/** Immutable record published before a new Attempt may be prepared/claimed. */
export interface WorkRecoveryContinuationRecord {
  readonly schemaVersion: typeof WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION;
  readonly kind: typeof WORK_RECOVERY_CONTINUATION_ARTIFACT_KIND;
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly nextAttemptId: string;
  readonly sourceAttemptId: string | null;
  readonly sourceSessionId: string | null;
  readonly selection: RuntimeRecoverySelection;
  readonly decision: RuntimeRecoveryDecision;
  /** Requested source retained for audit even when auto degraded to new. */
  readonly source: RuntimeRecoveryReference | null;
  readonly policy: WorkRecoveryPolicySnapshot;
  readonly workspace: WorkRecoveryWorkspaceFacts;
  readonly reconciliationEvidence: ExecutionInputRef | null;
  readonly requiredInputs: readonly ExecutionInputRef[];
  readonly handoff: WorkRecoveryHandoff | null;
  readonly recordedAtUtcMs: number;
}

export interface WorkRecoveryNextAttempt {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
}

/**
 * Decision input. currentInputSnapshot is the already-prepared, current Task
 * input identity (without this recovery record); it supplies the authoritative
 * requirements/acceptance/dependency/verification/policy comparison basis.
 */
export interface WorkRecoveryContinuationRequest {
  readonly schemaVersion: typeof WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly next: WorkRecoveryNextAttempt;
  readonly selection: RuntimeRecoverySelection;
  readonly strategy: RuntimeStrategyV1;
  readonly taskRevision: number;
  readonly currentInputSnapshot: ExecutionInputRef;
  readonly reconciliationEvidence: ExecutionInputRef | null;
  readonly workspace: WorkRecoveryWorkspaceFacts;
}

export interface WorkRecoveryContinuationResult {
  readonly record: WorkRecoveryContinuationRecord;
  readonly evidenceRef: ExecutionInputRef;
}

function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, keys, context, field);
  return raw;
}
function id(value: unknown, field: string): string {
  return validateStableId(value, context, field);
}
function text(value: unknown, field: string): string {
  return requireNonEmptyString(value, context, field);
}
function digest(value: unknown, field: string): string {
  return validateSha256Digest(value, context, field);
}
function commit(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw validationError(context, field, 'invalid_commit');
  }
  return value;
}
function ref(value: unknown, field: string): ExecutionInputRef {
  return validateExecutionInputRef(value, field);
}

function policy(value: unknown, field: string): WorkRecoveryPolicySnapshot {
  const raw = object(
    value,
    ['executionConfig', 'configSource', 'configSourceKey', 'permissionsDigest', 'checkPolicyDigest', 'taskRevision'],
    field,
  );
  return {
    executionConfig: { ...requirePlainObject(raw.executionConfig, context, `${field}.executionConfig`) },
    configSource: text(raw.configSource, `${field}.configSource`),
    configSourceKey: raw.configSourceKey === null ? null : id(raw.configSourceKey, `${field}.configSourceKey`),
    permissionsDigest: digest(raw.permissionsDigest, `${field}.permissionsDigest`),
    checkPolicyDigest: digest(raw.checkPolicyDigest, `${field}.checkPolicyDigest`),
    taskRevision: validatePositiveInteger(raw.taskRevision, context, `${field}.taskRevision`),
  };
}

export function validateWorkRecoveryWorkspaceFacts(
  value: unknown,
  field = 'workspace',
): WorkRecoveryWorkspaceFacts {
  const raw = object(value, ['workspaceId', 'repositoryIdentity', 'branch', 'headCommit', 'codeDigest'], field);
  return {
    workspaceId: id(raw.workspaceId, `${field}.workspaceId`),
    repositoryIdentity: text(raw.repositoryIdentity, `${field}.repositoryIdentity`),
    branch: text(raw.branch, `${field}.branch`),
    headCommit: commit(raw.headCommit, `${field}.headCommit`),
    codeDigest: digest(raw.codeDigest, `${field}.codeDigest`),
  };
}

function requiredInputs(value: unknown, field: string, projectId: string): ExecutionInputRef[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw validationError(context, field, 'invalid_bounded_array');
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = ref(entry, `${field}[${index}]`);
    if (item.projectId !== projectId) {
      throw validationError(context, `${field}[${index}].projectId`, 'project_mismatch');
    }
    if (seen.has(item.artifactId)) {
      throw validationError(context, `${field}[${index}].artifactId`, 'duplicate_artifact');
    }
    seen.add(item.artifactId);
    return item;
  });
}

function handoff(value: unknown, field: string, projectId: string): WorkRecoveryHandoff {
  const raw = object(value, [
    'previousAttemptId', 'previousStatus', 'previousExecutionStage', 'previousEndedAtUtcMs',
    'previousErrorKind', 'previousDiagnosticRef', 'codeRef', 'requiredInputRefs', 'note',
  ], field);
  return {
    previousAttemptId: id(raw.previousAttemptId, `${field}.previousAttemptId`),
    previousStatus: text(raw.previousStatus, `${field}.previousStatus`),
    previousExecutionStage: text(raw.previousExecutionStage, `${field}.previousExecutionStage`),
    previousEndedAtUtcMs: raw.previousEndedAtUtcMs === null
      ? null
      : validateNonNegativeInteger(raw.previousEndedAtUtcMs, context, `${field}.previousEndedAtUtcMs`),
    previousErrorKind: raw.previousErrorKind === null ? null : text(raw.previousErrorKind, `${field}.previousErrorKind`),
    previousDiagnosticRef: raw.previousDiagnosticRef === null ? null : id(raw.previousDiagnosticRef, `${field}.previousDiagnosticRef`),
    codeRef: raw.codeRef === null ? null : id(raw.codeRef, `${field}.codeRef`),
    requiredInputRefs: requiredInputs(raw.requiredInputRefs, `${field}.requiredInputRefs`, projectId),
    note: text(raw.note, `${field}.note`),
  };
}

export function validateWorkRecoveryContinuationRecord(
  value: unknown,
  owner: { readonly projectId?: string; readonly taskId?: string } = {},
): WorkRecoveryContinuationRecord {
  const field = 'recovery';
  const raw = object(value, [
    'schemaVersion', 'kind', 'projectId', 'featureId', 'taskId', 'nextAttemptId',
    'sourceAttemptId', 'sourceSessionId', 'selection', 'decision', 'source', 'policy',
    'workspace', 'reconciliationEvidence', 'requiredInputs', 'handoff', 'recordedAtUtcMs',
  ], field);
  if (raw.schemaVersion !== WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION) {
    throw validationError(context, `${field}.schemaVersion`, 'unsupported_schema_version');
  }
  if (raw.kind !== WORK_RECOVERY_CONTINUATION_ARTIFACT_KIND) {
    throw validationError(context, `${field}.kind`, 'invalid_kind');
  }
  const projectId = id(raw.projectId, `${field}.projectId`);
  const taskId = id(raw.taskId, `${field}.taskId`);
  if (owner.projectId !== undefined && owner.projectId !== projectId) {
    throw validationError(context, `${field}.projectId`, 'project_mismatch');
  }
  if (owner.taskId !== undefined && owner.taskId !== taskId) {
    throw validationError(context, `${field}.taskId`, 'task_mismatch');
  }
  const selection = validateRuntimeRecoverySelection(raw.selection, `${field}.selection`);
  const decision = validateRuntimeRecoveryDecision(raw.decision, `${field}.decision`);
  if (decision.mode === 'rejected') {
    throw validationError(context, `${field}.decision`, 'rejected_not_executable');
  }
  const source = raw.source === null ? null : validateRuntimeRecoveryReference(raw.source);
  const sourceAttemptId = raw.sourceAttemptId === null ? null : id(raw.sourceAttemptId, `${field}.sourceAttemptId`);
  const sourceSessionId = raw.sourceSessionId === null ? null : id(raw.sourceSessionId, `${field}.sourceSessionId`);
  if (source !== null) {
    if (source.purpose !== 'work' || source.sourceProjectId !== projectId || source.sourceTaskId !== taskId) {
      throw validationError(context, `${field}.source`, 'source_identity_mismatch');
    }
    if (source.sourceAttemptId !== sourceAttemptId || source.sourceSessionId !== sourceSessionId) {
      throw validationError(context, `${field}.source`, 'source_attempt_session_mismatch');
    }
    if (selection.mode === 'new') {
      throw validationError(context, `${field}.selection`, 'new_forbids_source');
    }
    const selected = selection.source;
    if (selected === undefined || JSON.stringify(selected) !== JSON.stringify(source)) {
      throw validationError(context, `${field}.source`, 'selection_source_mismatch');
    }
    if (decision.mode === 'resume') {
      if (decision.kind !== selection.kind || source.kind !== selection.kind) {
        throw validationError(context, `${field}.decision.kind`, 'decision_kind_mismatch');
      }
    }
  } else {
    if (sourceAttemptId !== null || sourceSessionId !== null) {
      throw validationError(context, `${field}.sourceAttemptId`, 'source_attempt_requires_source');
    }
    if (selection.mode === 'required' || (selection.mode === 'auto' && selection.source !== undefined)) {
      throw validationError(context, `${field}.source`, 'source_missing');
    }
    if (decision.mode === 'resume') {
      throw validationError(context, `${field}.decision`, 'resume_requires_source');
    }
  }
  if (selection.mode === 'new' && decision.mode !== 'new') {
    throw validationError(context, `${field}.decision`, 'new_selection_requires_new_decision');
  }
  if (selection.mode === 'required' && decision.mode !== 'resume') {
    throw validationError(context, `${field}.decision`, 'required_cannot_degrade');
  }
  const reconciliationEvidence = raw.reconciliationEvidence === null
    ? null
    : ref(raw.reconciliationEvidence, `${field}.reconciliationEvidence`);
  if (reconciliationEvidence !== null && reconciliationEvidence.projectId !== projectId) {
    throw validationError(context, `${field}.reconciliationEvidence.projectId`, 'project_mismatch');
  }
  const inputs = requiredInputs(raw.requiredInputs, `${field}.requiredInputs`, projectId);
  if (reconciliationEvidence !== null && !inputs.some((item) =>
    item.artifactId === reconciliationEvidence.artifactId && item.contentHash === reconciliationEvidence.contentHash)) {
    throw validationError(context, `${field}.requiredInputs`, 'reconciliation_reference_missing');
  }
  if (source !== null) {
    if (!inputs.some((item) => item.artifactId === source.nativeArchiveRef
      && item.contentHash === source.sourceDigest)) {
      throw validationError(context, `${field}.requiredInputs`, 'source_archive_missing');
    }
    if (source.kind === 'checkpoint' && !inputs.some((item) => item.artifactId === source.checkpointRef)) {
      throw validationError(context, `${field}.requiredInputs`, 'checkpoint_reference_missing');
    }
  }
  const handoffValue = raw.handoff === null ? null : handoff(raw.handoff, `${field}.handoff`, projectId);
  if (handoffValue !== null) {
    if (handoffValue.previousAttemptId === id(raw.nextAttemptId, `${field}.nextAttemptId`)) {
      throw validationError(context, `${field}.handoff.previousAttemptId`, 'handoff_attempt_is_next');
    }
    if (sourceAttemptId !== null && handoffValue.previousAttemptId !== sourceAttemptId) {
      throw validationError(context, `${field}.handoff.previousAttemptId`, 'handoff_source_attempt_mismatch');
    }
    for (const required of handoffValue.requiredInputRefs) {
      if (!inputs.some((item) => item.artifactId === required.artifactId &&
          item.contentHash === required.contentHash)) {
        throw validationError(context, `${field}.handoff.requiredInputRefs`, 'handoff_reference_missing');
      }
    }
  }
  const nextAttemptId = id(raw.nextAttemptId, `${field}.nextAttemptId`);
  return {
    schemaVersion: WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION,
    kind: WORK_RECOVERY_CONTINUATION_ARTIFACT_KIND,
    projectId,
    featureId: id(raw.featureId, `${field}.featureId`),
    taskId,
    nextAttemptId,
    sourceAttemptId,
    sourceSessionId,
    selection,
    decision,
    source,
    policy: policy(raw.policy, `${field}.policy`),
    workspace: validateWorkRecoveryWorkspaceFacts(raw.workspace, `${field}.workspace`),
    reconciliationEvidence,
    requiredInputs: inputs,
    handoff: handoffValue,
    recordedAtUtcMs: validateNonNegativeInteger(raw.recordedAtUtcMs, context, `${field}.recordedAtUtcMs`),
  };
}

export function validateWorkRecoveryContinuationRequest(value: unknown): WorkRecoveryContinuationRequest {
  const field = 'request';
  const raw = object(value, [
    'schemaVersion', 'projectId', 'featureId', 'taskId', 'next', 'selection', 'strategy',
    'taskRevision', 'currentInputSnapshot', 'reconciliationEvidence', 'workspace',
  ], field);
  if (raw.schemaVersion !== WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION) {
    throw validationError(context, `${field}.schemaVersion`, 'unsupported_schema_version');
  }
  const next = object(raw.next, ['attemptId', 'sessionId', 'invocationId', 'executionVersion'], `${field}.next`);
  const currentInputSnapshot = ref(raw.currentInputSnapshot, `${field}.currentInputSnapshot`);
  if (currentInputSnapshot.purpose !== 'snapshot') {
    throw validationError(context, `${field}.currentInputSnapshot.purpose`, 'snapshot_required');
  }
  const reconciliationEvidence = raw.reconciliationEvidence === null
    ? null
    : ref(raw.reconciliationEvidence, `${field}.reconciliationEvidence`);
  return {
    schemaVersion: WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION,
    projectId: id(raw.projectId, `${field}.projectId`),
    featureId: id(raw.featureId, `${field}.featureId`),
    taskId: id(raw.taskId, `${field}.taskId`),
    next: {
      attemptId: id(next.attemptId, `${field}.next.attemptId`),
      sessionId: id(next.sessionId, `${field}.next.sessionId`),
      invocationId: id(next.invocationId, `${field}.next.invocationId`),
      executionVersion: validatePositiveInteger(next.executionVersion, context, `${field}.next.executionVersion`),
    },
    selection: validateRuntimeRecoverySelection(raw.selection, `${field}.selection`),
    strategy: validateRuntimeStrategy(raw.strategy, context, `${field}.strategy`),
    taskRevision: validatePositiveInteger(raw.taskRevision, context, `${field}.taskRevision`),
    currentInputSnapshot,
    reconciliationEvidence,
    workspace: validateWorkRecoveryWorkspaceFacts(raw.workspace, `${field}.workspace`),
  };
}
