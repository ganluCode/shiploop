import { validateProfileExecutionSnapshot } from './project-profile.js';
import type { ProfileExecutionSnapshot } from './project-profile.js';
import { validateWorkProcessIdentity } from './work-resources.js';
import type { CommandProcessIdentity } from './command-process.js';
import { validateRuntimeFallbackAttemptMetadata, type RuntimeFallbackAttemptMetadata } from './runtime-fallback-switch.js';
import type { PreparedExecutionInputGroup, ExecutionInputGroupBodyRef } from './execution-input-prepare.js';
import {
  validatePlanningAttemptInputSnapshot,
  type PlanningAttemptInputSnapshot,
} from './planning-claim.js';
import { CONTEXT_INPUT_SUPPORTED_SCHEMA_VERSIONS, isContextBuildError, validateContextReworkInput, type ContextReworkInput } from './context-build.js';
import { validateWorkRecoveryContinuationRecord } from './work-recovery-continuation.js';
import type { WorkRecoveryContinuationRecord } from './work-recovery-continuation.js';
import { validateExecutionInputRef } from './execution-input.js';
import { EXECUTION_SNAPSHOT_MAX_BYTES } from './execution-store.js';
import {
  rejectUnknownKeys, requirePlainObject, validateStableId, validateSha256Digest,
  validateArtifactLocator, validateNonNegativeInteger, validatePositiveInteger, validationError,
} from './validation.js';

export const ATTEMPT_STATUSES = ['preparing', 'executing', 'verifying', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export const ACTIVE_ATTEMPT_STATUSES = ['preparing', 'executing', 'verifying'] as const;
export const ATTEMPT_EXECUTION_STAGES = ['preflight', 'runtime', 'verification', 'commit', 'cleanup'] as const;
export type AttemptStatus = typeof ATTEMPT_STATUSES[number];
export type AttemptExecutionStage = typeof ATTEMPT_EXECUTION_STAGES[number];

/** Unknown measurements remain null, including partially reported usage. */
export interface AttemptUsageSummary {
  readonly schemaVersion: 1;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicros: number | null;
  readonly currency: string | null;
}
export interface AttemptRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly revision: number;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly number: number;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly leaseUntilUtcMs: number;
  readonly status: AttemptStatus;
  readonly executionStage: AttemptExecutionStage;
  /** Frozen prepared input group identity; bodies live in immutable Artifacts.
   *  P05-1 / F-005：编码与规划判别（planning 快照携带 purpose='planning'，
   *  不携带业务计划批准身份）。 */
  readonly inputSnapshot: AttemptInputSnapshot;
  readonly inputDigest: string;
  readonly inputRef: string;
  /** P06-1：Attempt 创建时固定的画像/能力模块身份摘要。 */
  readonly profile?: ProfileExecutionSnapshot;
  /** Core identities, never SDK requestId/providerSessionId aliases. No Session table here. */
  readonly sessionId: string | null;
  readonly invocationId: string | null;
  readonly codeRef: string | null;
  readonly errorKind: string | null;
  readonly diagnosticRef: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly usageSummary: AttemptUsageSummary | null;
}
export interface WorkspaceLeaseRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly revision: number;
  readonly projectId: string;
  readonly resourceKey: string;
  readonly resourceKind: 'global' | 'project' | 'workspace';
  readonly ownerKind: 'attempt';
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly state: 'held' | 'quarantined';
  readonly leaseUntilUtcMs: number;
  readonly processIdentity: AttemptProcessIdentity | ({ readonly schemaVersion: 2 } & CommandProcessIdentity) | null;
}
export interface AttemptProcessIdentity {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly startedAtUtcMs: number;
  readonly processGroupId: number | null;
}
/** Synchronous consistent reads, also usable inside the caller's transaction. */
export interface AttemptStore {
  getAttempt(projectId: unknown, attemptId: unknown): AttemptRecord;
  listTaskAttempts(projectId: unknown, taskId: unknown): readonly AttemptRecord[];
  /** P03-9 / F-003：取消目标下的活动 Attempt（preparing/executing/verifying）。 */
  listActiveAttempts(projectId: unknown, targetKind: 'run' | 'batch' | 'feature', targetId: unknown): readonly AttemptRecord[];
  /** P03-9 / F-003：取消目标下仍持有 workspace 租约的 Attempt（含已结束但占用未收尾）。 */
  listAttemptsWithLeases(projectId: unknown, targetKind: 'run' | 'batch' | 'feature', targetId: unknown): readonly AttemptRecord[];
  listWorkspaceLeases(projectId: unknown): readonly WorkspaceLeaseRecord[];
}

const context = { operation: 'AttemptStore.validate' };
function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, keys, context, field);
  return raw;
}
function text(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0-\x1f\x7f]/.test(value)) {
    throw validationError(context, field, 'invalid_bounded_text');
  }
  return value;
}
function id(value: unknown, field: string): string { return validateStableId(value, context, field); }
function digest(value: unknown, field: string): string { return validateSha256Digest(value, context, field); }
function nonnegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw validationError(context, field, 'invalid_safe_integer');
  return validateNonNegativeInteger(value, context, field);
}
function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw validationError(context, field, 'invalid_safe_integer');
  return validatePositiveInteger(value, context, field);
}
function nullable<T>(value: unknown, validate: (v: unknown, f: string) => T, field: string): T | null {
  return value === null ? null : validate(value, field);
}
function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw validationError(context, field, 'invalid_enum');
  return value as T;
}
function version(value: unknown, field: string): 1 {
  if (value !== 1) throw validationError(context, field, 'unsupported_schema_version');
  return 1;
}
function bodyRef(value: unknown, field: string): ExecutionInputGroupBodyRef {
  const raw = object(value, ['artifactId', 'version', 'contentHash', 'sizeBytes', 'locator', 'mediaType'], field);
  return { artifactId: id(raw.artifactId, `${field}.artifactId`), version: positive(raw.version, `${field}.version`),
    contentHash: digest(raw.contentHash, `${field}.contentHash`), sizeBytes: nonnegative(raw.sizeBytes, `${field}.sizeBytes`),
    locator: validateArtifactLocator(raw.locator, context, `${field}.locator`), mediaType: text(raw.mediaType, `${field}.mediaType`) };
}

/** Attempt 冻结输入快照：编码（PreparedExecutionInputGroup）或规划（P05-1/F-005）判别。 */
export type AttemptInputSnapshot = PreparedExecutionInputGroup | PlanningAttemptInputSnapshot;

/** 判别 planning Attempt 输入快照（编码快照恒 false）。 */
export function isPlanningAttemptSnapshot(
  snapshot: AttemptInputSnapshot,
): snapshot is PlanningAttemptInputSnapshot {
  return (snapshot as { purpose?: unknown }).purpose === 'planning';
}

/** Reuses the prepared input contract; no inline content, credential or arbitrary JSON fields.
 *  P05-1 / F-005：planning 快照按独立契约校验（purpose 判别；不要求业务计划批准身份）。 */
export function validateAttemptInputSnapshot(value: unknown): AttemptInputSnapshot {
  const probe = requirePlainObject(value, context, 'inputSnapshot');
  if (probe['purpose'] !== undefined) {
    return validatePlanningAttemptInputSnapshot(value);
  }
  const raw = object(value, ['schemaVersion', 'projectId', 'featureId', 'taskId', 'group', 'requiredInputs',
    'digests', 'approval', 'taskRevision', 'promptBytes', 'tokenEstimate', 'preparedAtUtcMs', 'profile', 'rework', 'recovery', 'runtimeFallback'], 'inputSnapshot');
  // 历史快照不随 ContextBuilder 升版失效：v1/v2 历史快照与当前版本均可读回，未知版本拒绝。
  const snapshotSchemaVersion = raw.schemaVersion as number;
  if (!(CONTEXT_INPUT_SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(snapshotSchemaVersion)) {
    throw validationError(context, 'inputSnapshot.schemaVersion', 'unsupported_context_version');
  }
  const projectId = id(raw.projectId, 'inputSnapshot.projectId');
  const profile = raw.profile === undefined || raw.profile === null ? undefined : validateProfileExecutionSnapshot(raw.profile);
  const group = object(raw.group, ['snapshot', 'manifest', 'prompt'], 'inputSnapshot.group');
  const digests = object(raw.digests, ['snapshotDigest', 'manifestDigest', 'promptDigest', 'strategyCopyDigest', 'permissionsDigest'], 'inputSnapshot.digests');
  const approval = object(raw.approval, ['planDigest', 'checkPolicyDigest', 'decisionId', 'featureRevision'], 'inputSnapshot.approval');
  const estimate = object(raw.tokenEstimate, ['value', 'kind', 'method'], 'inputSnapshot.tokenEstimate');
  if (!Array.isArray(raw.requiredInputs) || raw.requiredInputs.length > 256) throw validationError(context, 'inputSnapshot.requiredInputs', 'invalid_bounded_array');
  const requiredInputs = raw.requiredInputs.map(ref => {
    const input = validateExecutionInputRef(ref, context.operation);
    positive(input.version, 'inputSnapshot.requiredInputs.version');
    nonnegative(input.sizeBytes, 'inputSnapshot.requiredInputs.sizeBytes');
    return input;
  });
  if (requiredInputs.some(ref => ref.projectId !== projectId)) throw validationError(context, 'inputSnapshot.requiredInputs', 'project_mismatch');
  const result: PreparedExecutionInputGroup = {
    schemaVersion: raw.schemaVersion as number, projectId, featureId: id(raw.featureId, 'inputSnapshot.featureId'), taskId: id(raw.taskId, 'inputSnapshot.taskId'),
    group: { snapshot: bodyRef(group.snapshot, 'inputSnapshot.group.snapshot'),
      manifest: bodyRef(group.manifest, 'inputSnapshot.group.manifest'), prompt: bodyRef(group.prompt, 'inputSnapshot.group.prompt') },
    requiredInputs, digests: { snapshotDigest: digest(digests.snapshotDigest, 'inputSnapshot.digests.snapshotDigest'),
      manifestDigest: digest(digests.manifestDigest, 'inputSnapshot.digests.manifestDigest'),
      promptDigest: digest(digests.promptDigest, 'inputSnapshot.digests.promptDigest'),
      strategyCopyDigest: digest(digests.strategyCopyDigest, 'inputSnapshot.digests.strategyCopyDigest'),
      permissionsDigest: digest(digests.permissionsDigest, 'inputSnapshot.digests.permissionsDigest') },
    approval: { planDigest: digest(approval.planDigest, 'inputSnapshot.approval.planDigest'),
      checkPolicyDigest: digest(approval.checkPolicyDigest, 'inputSnapshot.approval.checkPolicyDigest'),
      decisionId: nullable(approval.decisionId, id, 'inputSnapshot.approval.decisionId'),
      featureRevision: positive(approval.featureRevision, 'inputSnapshot.approval.featureRevision') },
    ...(profile === undefined ? {} : { profile }),
    taskRevision: positive(raw.taskRevision, 'inputSnapshot.taskRevision'), promptBytes: nonnegative(raw.promptBytes, 'inputSnapshot.promptBytes'),
    tokenEstimate: { value: nonnegative(estimate.value, 'inputSnapshot.tokenEstimate.value'),
      kind: member(estimate.kind, ['estimation'], 'inputSnapshot.tokenEstimate.kind'), method: text(estimate.method, 'inputSnapshot.tokenEstimate.method') },
    preparedAtUtcMs: nonnegative(raw.preparedAtUtcMs, 'inputSnapshot.preparedAtUtcMs'),
  };
  // F-012：可选同 Task 返工身份（仅 schemaVersion ≥ 2 返工构建；v1 历史快照
  // 不携带该键，携带即拒绝）。形态复用 ContextBuild 返工契约，跨 Task/跨项目/
  // 矛盾恢复记录与非法证据引用一律 validation 拒绝。
  let rework: ContextReworkInput | undefined;
  if (raw.rework !== undefined && raw.rework !== null) {
    if (snapshotSchemaVersion < 2) {
      throw validationError(context, 'inputSnapshot.rework', 'rework_requires_context_v2');
    }
    try {
      rework = validateContextReworkInput(raw.rework, { projectId, taskId: result.taskId });
    } catch (error) {
      if (isContextBuildError(error)) {
        throw validationError(context, 'inputSnapshot.rework', 'invalid_rework', (error as Error).message);
      }
      throw error;
    }
  }
  const snapshot: PreparedExecutionInputGroup = rework === undefined ? result : { ...result, rework };
  let recovery: WorkRecoveryContinuationRecord | undefined;
  if (raw.recovery !== undefined && raw.recovery !== null) {
    if (snapshotSchemaVersion < 3) {
      throw validationError(context, 'inputSnapshot.recovery', 'recovery_requires_context_v3');
    }
    try {
      recovery = validateWorkRecoveryContinuationRecord(raw.recovery, { projectId, taskId: result.taskId });
    } catch (error) {
      throw validationError(context, 'inputSnapshot.recovery', 'invalid_recovery', (error as Error).message);
    }
    for (const required of recovery.requiredInputs) {
      if (!requiredInputs.some((ref) => ref.artifactId === required.artifactId &&
          ref.contentHash === required.contentHash && ref.version === required.version)) {
        throw validationError(context, 'inputSnapshot.recovery.requiredInputs', 'required_reference_missing');
      }
    }
  }
  const complete = recovery === undefined ? snapshot : { ...snapshot, recovery };
  const withFallback = raw.runtimeFallback === undefined || raw.runtimeFallback === null
    ? complete : { ...complete, runtimeFallback: validateRuntimeFallbackAttemptMetadata(raw.runtimeFallback) };
  if (Buffer.byteLength(JSON.stringify(withFallback), 'utf8') > EXECUTION_SNAPSHOT_MAX_BYTES) throw validationError(context, 'inputSnapshot', 'limit_exceeded');
  return withFallback;
}

export function validateAttemptUsageSummary(value: unknown): AttemptUsageSummary | null {
  if (value === null) return null;
  const raw = object(value, ['schemaVersion', 'inputTokens', 'outputTokens', 'costMicros', 'currency'], 'usageSummary');
  const currency = nullable(raw.currency, text, 'usageSummary.currency');
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw validationError(context, 'usageSummary.currency', 'invalid_currency');
  const costMicros = nullable(raw.costMicros, nonnegative, 'usageSummary.costMicros');
  if (costMicros !== null && currency === null) throw validationError(context, 'usageSummary.currency', 'cost_requires_currency');
  return { schemaVersion: version(raw.schemaVersion, 'usageSummary.schemaVersion'),
    inputTokens: nullable(raw.inputTokens, nonnegative, 'usageSummary.inputTokens'),
    outputTokens: nullable(raw.outputTokens, nonnegative, 'usageSummary.outputTokens'), costMicros, currency };
}

export function validateAttemptRecord(value: unknown): AttemptRecord {
  const raw = object(value, ['id', 'createdAtUtcMs', 'updatedAtUtcMs', 'revision', 'projectId', 'featureId', 'runId', 'taskId',
    'number', 'owner', 'hostInstanceId', 'executionVersion', 'leaseUntilUtcMs', 'status', 'executionStage',
    'inputSnapshot', 'inputDigest', 'inputRef', 'sessionId', 'invocationId', 'codeRef', 'errorKind', 'diagnosticRef',
    'startedAtUtcMs', 'endedAtUtcMs', 'durationMs', 'exitCode', 'usageSummary'], 'attempt');
  const inputSnapshot = validateAttemptInputSnapshot(raw.inputSnapshot);
  const projectId = id(raw.projectId, 'projectId'), featureId = id(raw.featureId, 'featureId'), taskId = id(raw.taskId, 'taskId');
  const inputDigest = digest(raw.inputDigest, 'inputDigest'), inputRef = id(raw.inputRef, 'inputRef');
  if (inputSnapshot.projectId !== projectId || inputSnapshot.featureId !== featureId || inputSnapshot.taskId !== taskId
    || inputSnapshot.digests.snapshotDigest !== inputDigest || inputSnapshot.group.snapshot.artifactId !== inputRef) {
    throw validationError(context, 'inputSnapshot', 'identity_mismatch');
  }
  const startedAtUtcMs = nullable(raw.startedAtUtcMs, nonnegative, 'startedAtUtcMs');
  const endedAtUtcMs = nullable(raw.endedAtUtcMs, nonnegative, 'endedAtUtcMs');
  if (startedAtUtcMs !== null && endedAtUtcMs !== null && endedAtUtcMs < startedAtUtcMs) throw validationError(context, 'endedAtUtcMs', 'invalid_time_order');
  if (raw.exitCode !== null && (typeof raw.exitCode !== 'number' || !Number.isSafeInteger(raw.exitCode))) throw validationError(context, 'exitCode', 'invalid_integer');
  return { id: id(raw.id, 'id'), createdAtUtcMs: nonnegative(raw.createdAtUtcMs, 'createdAtUtcMs'),
    updatedAtUtcMs: nonnegative(raw.updatedAtUtcMs, 'updatedAtUtcMs'), revision: positive(raw.revision, 'revision'),
    projectId, featureId, taskId, runId: id(raw.runId, 'runId'), number: positive(raw.number, 'number'),
    owner: id(raw.owner, 'owner'), hostInstanceId: id(raw.hostInstanceId, 'hostInstanceId'),
    executionVersion: positive(raw.executionVersion, 'executionVersion'), leaseUntilUtcMs: nonnegative(raw.leaseUntilUtcMs, 'leaseUntilUtcMs'),
    status: member(raw.status, ATTEMPT_STATUSES, 'status'), executionStage: member(raw.executionStage, ATTEMPT_EXECUTION_STAGES, 'executionStage'),
    inputSnapshot, inputDigest, inputRef, sessionId: nullable(raw.sessionId, id, 'sessionId'), invocationId: nullable(raw.invocationId, id, 'invocationId'),
    codeRef: nullable(raw.codeRef, id, 'codeRef'), diagnosticRef: nullable(raw.diagnosticRef, id, 'diagnosticRef'),
    errorKind: nullable(raw.errorKind, text, 'errorKind'), startedAtUtcMs, endedAtUtcMs,
    durationMs: nullable(raw.durationMs, nonnegative, 'durationMs'), exitCode: raw.exitCode as number | null,
    usageSummary: validateAttemptUsageSummary(raw.usageSummary) };
}

export function validateWorkspaceLeaseRecord(value: unknown): WorkspaceLeaseRecord {
  const raw = object(value, ['id', 'createdAtUtcMs', 'updatedAtUtcMs', 'revision', 'projectId', 'resourceKey', 'resourceKind',
    'ownerKind', 'owner', 'hostInstanceId', 'executionVersion', 'state', 'leaseUntilUtcMs', 'processIdentity'], 'lease');
  let processIdentity: WorkspaceLeaseRecord['processIdentity'] = null;
  if (raw.processIdentity !== null) {
    const candidate = requirePlainObject(raw.processIdentity, context, 'processIdentity');
    if (candidate.schemaVersion === 2) {
      const { schemaVersion: _version, ...identity } = candidate;
      processIdentity = { schemaVersion: 2, ...validateWorkProcessIdentity(identity) };
    } else {
      const process = object(candidate, ['schemaVersion', 'pid', 'startedAtUtcMs', 'processGroupId'], 'processIdentity');
      processIdentity = { schemaVersion: version(process.schemaVersion, 'processIdentity.schemaVersion'), pid: positive(process.pid, 'processIdentity.pid'),
        startedAtUtcMs: nonnegative(process.startedAtUtcMs, 'processIdentity.startedAtUtcMs'),
        processGroupId: nullable(process.processGroupId, positive, 'processIdentity.processGroupId') };
    }
  }
  return { id: id(raw.id, 'id'), createdAtUtcMs: nonnegative(raw.createdAtUtcMs, 'createdAtUtcMs'),
    updatedAtUtcMs: nonnegative(raw.updatedAtUtcMs, 'updatedAtUtcMs'), revision: positive(raw.revision, 'revision'), projectId: id(raw.projectId, 'projectId'),
    resourceKey: text(raw.resourceKey, 'resourceKey', 4096), resourceKind: member(raw.resourceKind, ['global', 'project', 'workspace'], 'resourceKind'),
    ownerKind: member(raw.ownerKind, ['attempt'], 'ownerKind'), owner: id(raw.owner, 'owner'), hostInstanceId: id(raw.hostInstanceId, 'hostInstanceId'),
    executionVersion: positive(raw.executionVersion, 'executionVersion'), state: member(raw.state, ['held', 'quarantined'], 'state'),
    leaseUntilUtcMs: nonnegative(raw.leaseUntilUtcMs, 'leaseUntilUtcMs'), processIdentity };
}
