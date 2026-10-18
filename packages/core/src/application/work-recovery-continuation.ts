/**
 * P03-9 / F-007 同 Task 通用续接决策与来源快照（application 层）。
 *
 * 编排顺序（任一不安全事实都在返回可执行记录前失败，且不启动 Runtime/
 * 不预占预算/不改旧输入）：
 * 1. 形态校验（本契约校验器；来源身份仍由 P03-3A 校验器复核）；
 * 2. 读取当前 Task 已准备的输入快照（本次恢复记录之外的权威任务/验收/
 *    依赖/验证输入/策略/权限身份），解析候选直接上一 Attempt；
 * 3. 停止与占用是三种模式的共同前提：任何活动 Attempt、遗留 held/
 *    quarantined 租约或未完成恢复现场核对都拒绝（new 不能绕过）；
 * 4. 来源核验：同 Task 直接上一 Attempt、来源 Session 一致、P03-6/F-006
 *    reconciled 证据（worktree/repo/branch/code/记录水位/Git 操作/原生
 *    单写入者）通过、原生归档/检查点 Artifact 身份与摘要实测一致；
 * 5. 当前输入/策略复核：任务/验收/依赖/验证输入与当前快照一致；仅
 *    provider/model 变化可交由 modelSwitchOnResume 能力判断，其他策略
 *    变化 auto 降级 new、required 拒绝；
 * 6. 复用 P03-3A `decideRuntimeRecovery` 产生实际决策；required 未支持
 *    明确拒绝；auto 降级保留完整原因；
 * 7. 发布不可变 continuation 记录（请求模式/决策/原因/来源 Attempt 与
 *    Session/当前完整策略/工作区身份/恢复现场与必需输入引用）并返回。
 *
 * 本模块不实现 Pi SDK resume、跨模型历史互通、原生库打开/复制，也不写
 * 预算、认领、Session 或 Runtime 生命周期；这些仍由 F-008/后续 Runner
 * 在记录发布之后按既有授权链路执行。
 */
import { createHash } from 'node:crypto';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { AttemptRecord, AttemptStore } from '../ports/attempt-store.js';
import { ACTIVE_ATTEMPT_STATUSES } from '../ports/attempt-store.js';
import {
  EXECUTION_SNAPSHOT_ARTIFACT_KIND,
} from '../ports/execution-input-prepare.js';
import type { ExecutionInputRef } from '../ports/execution-input.js';
import { stableStringify } from '../ports/feature-plan.js';
import { decideRuntimeRecovery } from '../ports/runtime-recovery.js';
import type {
  RuntimeRecoveryDecision,
  RuntimeRecoveryReference,
  RuntimeRecoverySelection,
} from '../ports/runtime-recovery.js';
import type { RuntimeRecoveryCatalog } from '../ports/runtime-recovery-catalog.js';
import { WORK_RECOVERY_RECONCILIATION_KIND } from '../ports/work-recovery-reconciliation.js';
import {
  WORK_RECOVERY_CONTINUATION_ARTIFACT_KIND,
  WORK_RECOVERY_CONTINUATION_MEDIA_TYPE,
  WORK_RECOVERY_CONTINUATION_LOCATOR_PREFIX,
  WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION,
  WorkRecoveryContinuationError,
  validateWorkRecoveryContinuationRequest,
} from '../ports/work-recovery-continuation.js';
import type {
  WorkRecoveryContinuationRecord,
  WorkRecoveryContinuationRequest,
  WorkRecoveryContinuationResult,
  WorkRecoveryHandoff,
  WorkRecoveryPolicySnapshot,
} from '../ports/work-recovery-continuation.js';
import { computeExecutionPermissionsDigest } from '../ports/execution-input-prepare.js';
import type { ArtifactPublisher } from './artifact-publish.js';
import type { ArtifactVerifier } from './artifact-verify.js';

const RECOVERY_PURPOSES = new Set(['recovery-archive', 'recovery-checkpoint', 'recovery-evidence']);
const RECOVERY_HANDOFF_NOTE = 'compact same-task handoff; native history is not inlined and no runtime was started';

export interface WorkRecoveryContinuationService {
  /** Decide and publish an immutable continuation record; never starts a Runtime. */
  plan(request: unknown): Promise<WorkRecoveryContinuationResult>;
}

export interface WorkRecoveryContinuationDeps {
  readonly attempts: Pick<AttemptStore, 'listTaskAttempts' | 'listWorkspaceLeases'>;
  readonly artifacts: Pick<ArtifactStore, 'getArtifact'>;
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
  readonly publisher: ArtifactPublisher;
  /** Trusted runtime evidence; missing descriptor keeps capability unverified. */
  readonly recoveryCatalog?: RuntimeRecoveryCatalog;
  readonly nowMs?: () => number;
}

function fail(
  reason: ConstructorParameters<typeof WorkRecoveryContinuationError>[0],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new WorkRecoveryContinuationError(reason, message, details);
}

function isActive(attempt: AttemptRecord): boolean {
  return (ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status);
}

function recoveryPurpose(value: string): boolean {
  return RECOVERY_PURPOSES.has(value) || value === 'failure-evidence';
}

function inputKey(ref: ExecutionInputRef): string {
  return `${ref.artifactId}\u0000${ref.version}\u0000${ref.contentHash}\u0000${ref.sizeBytes}\u0000${ref.locator}`;
}

function withoutRecoveryInputs(value: readonly ExecutionInputRef[]): string[] {
  return value.filter((ref) => !recoveryPurpose(ref.purpose)).map(inputKey).sort();
}

function taskProjection(snapshot: Record<string, unknown>): string {
  const task = typeof snapshot.task === 'object' && snapshot.task !== null
    ? snapshot.task as Record<string, unknown>
    : {};
  return stableStringify({
    projectId: snapshot.projectId,
    featureId: snapshot.featureId,
    taskId: snapshot.taskId,
    title: task.title,
    description: task.description,
    acceptance: task.acceptance,
    requirementsRefs: task.requirementsRefs,
    dependencies: task.dependencies,
    checkPolicy: snapshot.checkPolicy,
    deliveryPolicy: snapshot.deliveryPolicy,
    permissions: snapshot.permissions,
    requiredInputs: withoutRecoveryInputs(Array.isArray(snapshot.requiredInputs)
      ? snapshot.requiredInputs as ExecutionInputRef[]
      : []),
  });
}

function policyProjection(snapshot: Record<string, unknown>): Record<string, unknown> {
  const task = typeof snapshot.task === 'object' && snapshot.task !== null
    ? snapshot.task as Record<string, unknown>
    : {};
  return {
    executionConfig: task.executionConfig,
    configSource: task.configSource,
    configSourceKey: task.configSourceKey,
  };
}

function modelAdjustedPolicy(value: Record<string, unknown>): string {
  const config = typeof value.executionConfig === 'object' && value.executionConfig !== null
    ? { ...value.executionConfig as Record<string, unknown> }
    : {};
  if ('provider' in config) config.provider = '<provider>';
  if ('model' in config) config.model = '<model>';
  return stableStringify({
    executionConfig: config,
    configSource: value.configSource,
    configSourceKey: value.configSourceKey,
  });
}

function policySnapshot(
  snapshot: Record<string, unknown>,
  taskRevision: number,
): WorkRecoveryPolicySnapshot {
  const task = typeof snapshot.task === 'object' && snapshot.task !== null
    ? snapshot.task as Record<string, unknown>
    : {};
  const executionConfig = task.executionConfig;
  if (typeof executionConfig !== 'object' || executionConfig === null || Array.isArray(executionConfig)) {
    fail('reconciliation_unsafe', 'current input snapshot has no execution policy copy');
  }
  const permissionsValue = snapshot.permissions;
  const grants = typeof permissionsValue === 'object' && permissionsValue !== null
    ? (permissionsValue as Record<string, unknown>).grants
    : undefined;
  if (!Array.isArray(grants) || grants.some((grant) => typeof grant !== 'string')) {
    fail('reconciliation_unsafe', 'current input snapshot has no valid permissions face');
  }
  const checkPolicy = snapshot.checkPolicy;
  const checkPolicyDigest = typeof checkPolicy === 'object' && checkPolicy !== null
    ? (checkPolicy as Record<string, unknown>).digest
    : undefined;
  if (typeof checkPolicyDigest !== 'string') {
    fail('reconciliation_unsafe', 'current input snapshot has no check policy digest');
  }
  if (typeof task.configSource !== 'string' ||
      (task.configSourceKey !== null && typeof task.configSourceKey !== 'string')) {
    fail('reconciliation_unsafe', 'current input snapshot has no policy source identity');
  }
  return {
    executionConfig: { ...executionConfig as Record<string, unknown> },
    configSource: task.configSource,
    configSourceKey: task.configSourceKey as string | null,
    permissionsDigest: computeExecutionPermissionsDigest(grants as string[]),
    checkPolicyDigest,
    taskRevision,
  };
}

function parseJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('reconciliation_unsafe', `${label} is not valid UTF-8 JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('reconciliation_unsafe', `${label} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function createWorkRecoveryContinuationService(
  deps: WorkRecoveryContinuationDeps,
): WorkRecoveryContinuationService {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('WorkRecoveryContinuation dependencies are required');
  }
  for (const name of ['attempts', 'artifacts', 'verifier', 'publisher'] as const) {
    if (deps[name] === null || typeof deps[name] !== 'object') {
      throw new TypeError(`WorkRecoveryContinuation dependency ${name} is required`);
    }
  }
  const now = deps.nowMs ?? Date.now;

  return { plan };

  async function readArtifact(
    projectId: string,
    ref: Pick<ExecutionInputRef, 'artifactId' | 'kind' | 'version' | 'contentHash' | 'sizeBytes' | 'locator' | 'mediaType'>,
  ): Promise<{ content: Uint8Array; ref: ExecutionInputRef }> {
    let record;
    try {
      record = await deps.artifacts.getArtifact(projectId, ref.artifactId);
    } catch (cause) {
      fail('source_invalid', 'artifact is missing or cross-project', { artifactId: ref.artifactId, cause: String(cause) });
    }
    if (record.projectId !== projectId || record.id !== ref.artifactId || record.status !== 'ready' ||
        record.kind !== ref.kind || record.mediaType !== ref.mediaType || record.version !== ref.version ||
        record.contentHash !== ref.contentHash || record.sizeBytes !== ref.sizeBytes || record.locator !== ref.locator) {
      fail('source_invalid', 'artifact index identity drift', { artifactId: ref.artifactId });
    }
    let verified;
    try {
      verified = await deps.verifier.readVerifiedContent(projectId, ref.artifactId);
    } catch (cause) {
      fail('source_invalid', 'artifact content is unreadable or corrupt', { artifactId: ref.artifactId, cause: String(cause) });
    }
    if (verified.contentHash !== ref.contentHash || verified.sizeBytes !== ref.sizeBytes) {
      fail('source_invalid', 'artifact content digest mismatch', { artifactId: ref.artifactId });
    }
    return {
      content: verified.content,
      ref: {
        projectId,
        artifactId: record.id,
        kind: record.kind,
        purpose: 'recovery-evidence',
        version: record.version,
        contentHash: record.contentHash,
        sizeBytes: record.sizeBytes,
        locator: record.locator,
        mediaType: record.mediaType,
        origin: { kind: 'artifact' },
      },
    };
  }

  async function readByHash(
    projectId: string,
    artifactId: string,
    expectedHash: string,
    purpose: string,
  ): Promise<ExecutionInputRef> {
    let record;
    try {
      record = await deps.artifacts.getArtifact(projectId, artifactId);
    } catch (cause) {
      fail('source_invalid', 'source artifact is missing or cross-project', { artifactId, cause: String(cause) });
    }
    if (record.projectId !== projectId || record.status !== 'ready' || record.contentHash === null ||
        record.sizeBytes === null || record.contentHash !== expectedHash) {
      fail('source_invalid', 'source artifact identity or digest mismatch', { artifactId });
    }
    const verified = await deps.verifier.readVerifiedContent(projectId, artifactId).catch((cause) => {
      fail('source_invalid', 'source artifact is unreadable or corrupt', { artifactId, cause: String(cause) });
    });
    if (verified.contentHash !== expectedHash || verified.sizeBytes !== record.sizeBytes) {
      fail('source_invalid', 'source artifact content mismatch', { artifactId });
    }
    return {
      projectId,
      artifactId,
      kind: record.kind,
      purpose,
      version: record.version,
      contentHash: record.contentHash,
      sizeBytes: record.sizeBytes,
      locator: record.locator,
      mediaType: record.mediaType,
      origin: { kind: 'artifact' },
    };
  }

  function snapshotRef(projectId: string, attempt: AttemptRecord): ExecutionInputRef {
    const body = attempt.inputSnapshot.group.snapshot;
    return {
      projectId,
      artifactId: body.artifactId,
      kind: EXECUTION_SNAPSHOT_ARTIFACT_KIND,
      purpose: 'snapshot',
      version: body.version,
      contentHash: body.contentHash,
      sizeBytes: body.sizeBytes,
      locator: body.locator,
      mediaType: body.mediaType,
      origin: { kind: 'artifact' },
    };
  }

  function reconciliationFacts(
    value: Record<string, unknown>,
    candidate: AttemptRecord,
    request: WorkRecoveryContinuationRequest,
    source: RuntimeRecoveryReference | null,
  ): void {
    if (value.schemaVersion !== 1 || value.kind !== WORK_RECOVERY_RECONCILIATION_KIND) {
      fail('reconciliation_unsafe', 'reconciliation evidence kind/schema mismatch');
    }
    if (value.projectId !== request.projectId || value.featureId !== request.featureId ||
        value.taskId !== request.taskId || value.attemptId !== candidate.id) {
      fail('reconciliation_unsafe', 'reconciliation evidence belongs to a different attempt');
    }
    if (value.status !== 'reconciled' || value.taskPassed !== false || value.newAttemptCreated !== false) {
      fail('reconciliation_unsafe', 'recovery is not reconciled or claims a new attempt/passed result');
    }
    const gaps = value.gaps;
    const startupGaps = value.startupGaps;
    if (!Array.isArray(gaps) || gaps.length > 0 ||
        !Array.isArray(startupGaps) || startupGaps.length > 0) {
      fail('reconciliation_unsafe', 'recovery reconciliation reports gaps');
    }
    const workspace = value.workspace;
    if (typeof workspace !== 'object' || workspace === null) {
      fail('reconciliation_unsafe', 'recovery reconciliation has no workspace facts');
    }
    const facts = workspace as Record<string, unknown>;
    if (facts.status !== 'retained' ||
        facts.id !== request.workspace.workspaceId ||
        facts.repoIdentity !== request.workspace.repositoryIdentity ||
        facts.branch !== request.workspace.branch) {
      fail('reconciliation_unsafe', 'workspace identity/branch changed since recovery');
    }
    if (source !== null && facts.codeDigest !== request.workspace.codeDigest) {
      fail('reconciliation_unsafe', 'workspace code changed after recovery; native continuation is unsafe');
    }
    const recording = value.recording;
    if (typeof recording !== 'object' || recording === null) {
      fail('reconciliation_unsafe', 'recovery reconciliation has no recording facts');
    }
    const recordingFacts = recording as Record<string, unknown>;
    if (!Array.isArray(recordingFacts.gaps) || recordingFacts.gaps.length > 0) {
      fail('reconciliation_unsafe', 'recording waterline has gaps');
    }
    if (recordingFacts.sessionId !== null &&
        (recordingFacts.status !== 'ended' && recordingFacts.status !== 'stopped')) {
      fail('reconciliation_unsafe', 'recording session is not stopped');
    }
    if (!Array.isArray(value.gitOperations) ||
        value.gitOperations.some((item) => typeof item === 'object' && item !== null &&
          (item as Record<string, unknown>).outcome === 'unknown')) {
      fail('reconciliation_unsafe', 'git operations include unknown side effects');
    }
    const native = value.native;
    if (typeof native !== 'object' || native === null) {
      fail('reconciliation_unsafe', 'recovery reconciliation has no native facts');
    }
    const nativeFacts = native as Record<string, unknown>;
    if (nativeFacts.opened !== false) {
      fail('reconciliation_unsafe', 'native archive was opened during recovery');
    }
    if (source === null) {
      if (nativeFacts.singleWriter === 'not_referenced') return;
      if (nativeFacts.singleWriter !== 'confirmed_stopped' && nativeFacts.singleWriter !== 'never_started') {
        fail('reconciliation_unsafe', 'native single-writer stop is not confirmed');
      }
      return;
    }
    if (nativeFacts.singleWriter !== 'confirmed_stopped' || nativeFacts.sourceVerified !== true) {
      fail('reconciliation_unsafe', 'native source ownership/stop is not confirmed');
    }
    if (nativeFacts.sourceArchiveRef !== source.nativeArchiveRef ||
        nativeFacts.sourceDigest !== source.sourceDigest ||
        (source.kind === 'checkpoint' && nativeFacts.sourceArchiveRef === null)) {
      fail('reconciliation_unsafe', 'native source identity/digest differs from the requested source');
    }
  }

  async function plan(value: unknown): Promise<WorkRecoveryContinuationResult> {
    const request = validateWorkRecoveryContinuationRequest(value);
    const current = await readArtifact(request.projectId, request.currentInputSnapshot);
    const currentSnapshot = parseJson(current.content, 'current input snapshot');
    if (currentSnapshot.projectId !== request.projectId ||
        currentSnapshot.featureId !== request.featureId ||
        currentSnapshot.taskId !== request.taskId) {
      fail('input_changed', 'current input snapshot identity does not match the request');
    }
    const currentPolicy = policySnapshot(currentSnapshot, request.taskRevision);
    const currentConfig = currentPolicy.executionConfig as Record<string, unknown>;
    if (currentConfig.runtime !== request.strategy.runtime ||
        currentConfig.provider !== request.strategy.provider ||
        currentConfig.model !== request.strategy.model ||
        (currentConfig.credentialRef ?? undefined) !== request.strategy.credentialRef ||
        (currentConfig.endpointRef ?? undefined) !== request.strategy.endpointRef) {
      fail('policy_changed', 'request strategy does not match the current prepared policy copy');
    }
    const currentRequired = Array.isArray(currentSnapshot.requiredInputs)
      ? currentSnapshot.requiredInputs as ExecutionInputRef[]
      : [];

    const sameTask = [...deps.attempts.listTaskAttempts(request.projectId, request.taskId)]
      .filter((attempt) => attempt.id !== request.next.attemptId)
      .sort((left, right) => left.number - right.number);
    if (sameTask.some(isActive)) {
      fail('previous_active', 'a same-task attempt is still active');
    }
    const candidate = sameTask.length === 0 ? undefined : sameTask[sameTask.length - 1];
    const taskAttemptIds = new Set(sameTask.map((attempt) => attempt.id));
    const lingeringLeases = deps.attempts.listWorkspaceLeases(request.projectId)
      .filter((lease) => taskAttemptIds.has(lease.owner) &&
        (lease.state === 'held' || lease.state === 'quarantined'));
    if (lingeringLeases.length > 0) {
      fail('occupancy_unresolved', 'a previous same-task attempt still owns workspace occupancy', {
        owners: lingeringLeases.map((lease) => lease.owner),
      });
    }

    const selection = request.selection;
    const requestedSource = selection.mode === 'new' ? null : selection.source ?? null;
    let decision: RuntimeRecoveryDecision;
    let reasons: string[] = [];
    let sourceAttemptId: string | null = null;
    let sourceSessionId: string | null = null;
    let reconciliationRef: ExecutionInputRef | null = null;
    let handoff: WorkRecoveryHandoff | null = null;
    const extraInputs: ExecutionInputRef[] = [];

    if (candidate === undefined) {
      if (requestedSource !== null) {
        fail('candidate_missing', 'no direct previous attempt exists for the requested source');
      }
      decision = decideRuntimeRecovery({
        schemaVersion: 1,
        projectId: request.projectId,
        sessionId: request.next.sessionId,
        executionVersion: request.next.executionVersion,
        identity: {
          purpose: 'work', runId: 'recovery-plan', taskId: request.taskId,
          attemptId: request.next.attemptId,
        },
        invocationId: request.next.invocationId,
        strategy: request.strategy,
        recovery: selection,
      }, undefined);
      reasons = [...decision.reasons];
    } else {
      if (candidate.status !== 'succeeded' && candidate.status !== 'failed' &&
          candidate.status !== 'cancelled' && candidate.status !== 'interrupted') {
        fail('previous_active', 'the direct previous attempt is not terminal');
      }
      if (request.reconciliationEvidence === null) {
        fail('reconciliation_missing', 'a continuation requires reconciled recovery evidence');
      }
      reconciliationRef = request.reconciliationEvidence;
      const reconciliation = await readArtifact(request.projectId, reconciliationRef);
      reconciliationFacts(parseJson(reconciliation.content, 'reconciliation evidence'), candidate, request, requestedSource);

      if (requestedSource !== null) {
        if (requestedSource.purpose !== 'work') {
          fail('source_invalid', 'Work continuation requires a Work source purpose');
        }
        if (requestedSource.sourceAttemptId !== candidate.id) {
          fail('candidate_identity_mismatch', 'source Attempt is not the direct previous Attempt of the same task');
        }
        if (candidate.sessionId !== null && requestedSource.sourceSessionId !== candidate.sessionId) {
          fail('candidate_identity_mismatch', 'source Session does not match the source Attempt Session');
        }
        sourceAttemptId = candidate.id;
        sourceSessionId = requestedSource.sourceSessionId;

        const candidateSnapshot = parseJson(
          (await readArtifact(request.projectId, snapshotRef(request.projectId, candidate))).content,
          'source input snapshot',
        );
        if (taskProjection(candidateSnapshot) !== taskProjection(currentSnapshot)) {
          if (selection.mode === 'required') {
            fail('input_changed', 'requirements/acceptance/dependencies/verification inputs changed');
          }
          reasons.push('input:changed');
        }
        const candidatePolicy = policyProjection(candidateSnapshot);
        const currentPolicyProjection = policyProjection(currentSnapshot);
        if (stableStringify(candidatePolicy) !== stableStringify(currentPolicyProjection)) {
          if (modelAdjustedPolicy(candidatePolicy) !== modelAdjustedPolicy(currentPolicyProjection)) {
            if (selection.mode === 'required') {
              fail('policy_changed', 'execution policy changed beyond provider/model');
            }
            reasons.push('policy:changed');
          }
        }
        const archive = await readByHash(
          request.projectId, requestedSource.nativeArchiveRef, requestedSource.sourceDigest,
          requestedSource.kind === 'checkpoint' ? 'recovery-archive' : 'recovery-archive',
        );
        extraInputs.push(archive);
        if (requestedSource.kind === 'checkpoint') {
          let checkpointRecord;
          try {
            checkpointRecord = await deps.artifacts.getArtifact(request.projectId, requestedSource.checkpointRef);
          } catch (cause) {
            fail('source_invalid', 'checkpoint artifact is missing or cross-project', {
              artifactId: requestedSource.checkpointRef, cause: String(cause),
            });
          }
          if (checkpointRecord.status !== 'ready' || checkpointRecord.contentHash === null ||
              checkpointRecord.sizeBytes === null) {
            fail('source_invalid', 'checkpoint artifact is not ready');
          }
          extraInputs.push({
            projectId: request.projectId,
            artifactId: checkpointRecord.id,
            kind: checkpointRecord.kind,
            purpose: 'recovery-checkpoint',
            version: checkpointRecord.version,
            contentHash: checkpointRecord.contentHash,
            sizeBytes: checkpointRecord.sizeBytes,
            locator: checkpointRecord.locator,
            mediaType: checkpointRecord.mediaType,
            origin: { kind: 'artifact' },
          });
        }
      }
      decision = decideRuntimeRecovery({
        schemaVersion: 1,
        projectId: request.projectId,
        sessionId: request.next.sessionId,
        executionVersion: request.next.executionVersion,
        identity: {
          purpose: 'work', runId: candidate.runId, taskId: request.taskId,
          attemptId: request.next.attemptId,
        },
        invocationId: request.next.invocationId,
        strategy: request.strategy,
        recovery: selection,
      }, requestedSource === null ? undefined : deps.recoveryCatalog?.resolve(request.strategy.runtime));
      reasons = [...reasons, ...decision.reasons];
      if (requestedSource !== null && reasons.includes('input:changed')) {
        decision = selection.mode === 'required'
          ? fail('input_changed', 'required continuation cannot reuse changed task inputs')
          : { mode: 'new', reasons };
      } else if (requestedSource !== null && reasons.includes('policy:changed')) {
        decision = selection.mode === 'required'
          ? fail('policy_changed', 'required continuation cannot reuse changed policy')
          : { mode: 'new', reasons };
      } else if (decision.mode === 'rejected') {
        fail('capability_unsupported', 'required recovery capability/format is not verified', {
          reasons: [...decision.reasons],
        });
      }
      handoff = {
        previousAttemptId: candidate.id,
        previousStatus: candidate.status,
        previousExecutionStage: candidate.executionStage,
        previousEndedAtUtcMs: candidate.endedAtUtcMs,
        previousErrorKind: candidate.errorKind,
        previousDiagnosticRef: candidate.diagnosticRef,
        codeRef: candidate.codeRef,
        requiredInputRefs: currentRequired.map((ref) => ({ ...ref })),
        note: RECOVERY_HANDOFF_NOTE,
      };
    }

    const requiredInputs: ExecutionInputRef[] = [];
    const seen = new Set<string>();
    for (const item of [...currentRequired, ...(reconciliationRef === null ? [] : [reconciliationRef]), ...extraInputs]) {
      if (seen.has(item.artifactId)) continue;
      seen.add(item.artifactId);
      requiredInputs.push({ ...item, origin: { ...item.origin } });
    }
    if (requiredInputs.length > 256) {
      fail('input_changed', 'continuation required inputs exceed the input limit');
    }
    const record: WorkRecoveryContinuationRecord = {
      schemaVersion: WORK_RECOVERY_CONTINUATION_SCHEMA_VERSION,
      kind: WORK_RECOVERY_CONTINUATION_ARTIFACT_KIND,
      projectId: request.projectId,
      featureId: request.featureId,
      taskId: request.taskId,
      nextAttemptId: request.next.attemptId,
      sourceAttemptId,
      sourceSessionId,
      selection,
      decision,
      source: requestedSource,
      policy: currentPolicy,
      workspace: { ...request.workspace },
      reconciliationEvidence: reconciliationRef === null ? null : { ...reconciliationRef },
      requiredInputs,
      handoff,
      recordedAtUtcMs: now(),
    };
    const body = Buffer.from(stableStringify(record), 'utf8');
    const published = await deps.publisher.publishArtifact({
      projectId: request.projectId,
      kind: WORK_RECOVERY_CONTINUATION_ARTIFACT_KIND,
      mediaType: WORK_RECOVERY_CONTINUATION_MEDIA_TYPE,
      expectedHash: createHash('sha256').update(body).digest('hex'),
      locator: `${WORK_RECOVERY_CONTINUATION_LOCATOR_PREFIX}/${request.taskId}/${request.next.attemptId}`,
      content: [body],
    });
    const artifact = published.artifact;
    return {
      record,
      evidenceRef: {
        projectId: request.projectId,
        artifactId: artifact.id,
        kind: artifact.kind,
        purpose: 'recovery-continuation',
        version: artifact.version,
        contentHash: artifact.contentHash as string,
        sizeBytes: artifact.sizeBytes as number,
        locator: artifact.locator,
        mediaType: artifact.mediaType,
        origin: { kind: 'artifact' },
      },
    };
  }
}
