/** P05-1 / F-008 候选批准与拒绝。
 *
 * 候选正文在事务外由 ArtifactVerifier 做一次完整性读取；短写事务内再次核对
 * 上下文、Artifact 身份、输入/计划/检查策略和执行排他条件，然后直接把规范化
 * 候选应用到目标 Feature。批准、既有计划审批依据、规划上下文决策、事件和回执
 * 共享一个事务；拒绝只结束规划上下文并保留候选事实。
 */
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import {
  PublicError,
  createCompletedReceipt,
  createRejectedReceipt,
  mapStorageError,
} from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import type { ArtifactInputRef } from '../ports/artifact-store.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import type { ValidatedCommandEnvelope } from '../ports/commands.js';
import {
  FEATURE_PLAN_APPROVED_EVENT_TYPE,
  FEATURE_PLAN_REJECTED_EVENT_TYPE,
} from '../ports/plan-store.js';
import { validatePlanningCandidatePayload } from '../ports/planning-candidates.js';
import type { ValidatedPlanningCandidate } from '../ports/planning-candidates.js';
import type { PlanningContextRecord } from '../ports/planning-context.js';
import { resolveCurrentCheckPolicyDigest } from './plan-approval-verification.js';
import { selectTaskStrategy } from './task-strategy-selection.js';
import { createResultRef } from '../ports/command-receipts.js';
import { randomBytes } from 'node:crypto';

export const PLANNING_CANDIDATE_DECIDE_OPERATION = 'planning.candidate.decide' as const;

type Envelope = Extract<ValidatedCommandEnvelope, { operation: typeof PLANNING_CANDIDATE_DECIDE_OPERATION }>;

export interface PreparedPlanningCandidateDecision {
  readonly candidate: ValidatedPlanningCandidate;
  readonly artifact: {
    readonly artifactId: string;
    readonly contentHash: string;
    readonly sizeBytes: number;
  };
}

export interface PlanningCandidateDecisionReader {
  readonly readVerifiedContent: (projectId: string, artifactId: string) => Promise<{
    readonly content: Uint8Array;
    readonly contentHash: string;
    readonly sizeBytes: number;
  }>;
}

export interface PlanningCandidateDecisionPort {
  prepare(
    projectId: string,
    candidateId: string,
    candidateDigest: string,
  ): Promise<PreparedPlanningCandidateDecision>;
}

export function createPlanningCandidateDecisionPort(input: {
  readonly atomicStore: AtomicCommandStore;
  readonly verifier: PlanningCandidateDecisionReader;
}): PlanningCandidateDecisionPort {
  return {
    async prepare(projectId, candidateId, candidateDigest) {
      const context = input.atomicStore.getPlanningContextByCandidate(projectId, candidateId);
      if (context === null) {
        throw new PublicError('not_found', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, {
          details: { entityType: 'planning_candidate' },
        });
      }
      if (context.candidateDigest !== candidateDigest || context.candidateArtifactRef === null) {
        throw new PublicError('conflict', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, {
          details: { reason: 'candidate_digest_mismatch' },
        });
      }
      if (context.status !== 'candidate_published') {
        throw new PublicError('conflict', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, {
          details: { reason: 'candidate_not_approvable' },
        });
      }
      let verified;
      try {
        verified = await input.verifier.readVerifiedContent(projectId, context.candidateArtifactRef.artifactId);
      } catch (error) {
        throw new PublicError('conflict', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, {
          details: { reason: 'candidate_artifact_invalid' },
          cause: error,
        });
      }
      if (
        verified.contentHash !== context.candidateArtifactRef.contentHash ||
        verified.contentHash !== context.candidateArtifactRef.contentHash
      ) {
        throw new PublicError('conflict', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, {
          details: { reason: 'candidate_artifact_changed' },
        });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(verified.content)) as unknown;
      } catch (error) {
        throw new PublicError('conflict', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, {
          details: { reason: 'candidate_payload_invalid' },
          cause: error,
        });
      }
      let candidate: ValidatedPlanningCandidate;
      try {
        candidate = validatePlanningCandidatePayload(raw, { operation: PLANNING_CANDIDATE_DECIDE_OPERATION });
      } catch (error) {
        throw new PublicError('conflict', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, {
          details: { reason: 'candidate_payload_invalid' },
          cause: error,
        });
      }
      if (
        candidate.projectId !== projectId || candidate.candidateId !== candidateId ||
        candidate.runId !== context.runId || candidate.featureId !== context.featureId ||
        candidate.candidateDigest !== candidateDigest
      ) {
        throw new PublicError('conflict', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, {
          details: { reason: 'candidate_identity_mismatch' },
        });
      }
      return {
        candidate,
        artifact: {
          artifactId: context.candidateArtifactRef.artifactId,
          contentHash: verified.contentHash,
          sizeBytes: verified.sizeBytes,
        },
      };
    },
  };
}

export interface PlanningCandidateDecisionIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof PLANNING_CANDIDATE_DECIDE_OPERATION;
  readonly scope: Envelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

function rejected(identity: PlanningCandidateDecisionIdentity, transaction: CommandTransaction, details: Record<string, unknown>): CommandReceipt {
  const receipt = createRejectedReceipt({
    ...identity,
    error: new PublicError('conflict', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, { details }),
  });
  transaction.saveReceipt(receipt);
  return receipt;
}

function artifactStillReady(
  transaction: CommandTransaction,
  projectId: string,
  prepared: PreparedPlanningCandidateDecision,
): ArtifactInputRef {
  const current = transaction.getArtifactInputRef(projectId, prepared.artifact.artifactId);
  if (current.contentHash !== prepared.artifact.contentHash || current.sizeBytes !== prepared.artifact.sizeBytes) {
    throw new StorageError('conflict', PLANNING_CANDIDATE_DECIDE_OPERATION, '候选 Artifact 身份在批准前发生变化', {
      details: { reason: 'candidate_artifact_changed' },
    });
  }
  return current;
}

function collectReferences(candidate: ValidatedPlanningCandidate): readonly { artifactId: string; contentHash?: string }[] {
  return [
    ...candidate.plan.feature.sourceRefs,
    ...candidate.plan.tasks.flatMap(task => [...task.requirementsRefs]),
  ];
}

/** 在同一短写事务内应用候选或记录拒绝。 */
export function submitPlanningCandidateDecision(
  identity: PlanningCandidateDecisionIdentity,
  envelope: Envelope,
  transaction: CommandTransaction,
  prepared: PreparedPlanningCandidateDecision,
  nowUtcMs: number,
): CommandReceipt {
  const projectId = envelope.scope.projectId;
  transaction.getProject(projectId);
  const context = transaction.getPlanningContextByCandidate(projectId, envelope.payload.candidateId);
  if (context === null) {
    throw new PublicError('not_found', PLANNING_CANDIDATE_DECIDE_OPERATION, undefined, {
      details: { entityType: 'planning_candidate' },
    });
  }
  const snapshot = transaction.getFeaturePlan(projectId, context.featureId);
  const candidate = prepared.candidate;
  if (
    context.candidateDigest !== envelope.payload.candidateDigest ||
    context.status !== 'candidate_published' ||
    context.featureId !== candidate.featureId ||
    context.runId !== candidate.runId ||
    candidate.candidateDigest !== envelope.payload.candidateDigest
  ) {
    return rejected(identity, transaction, { reason: 'candidate_not_approvable' });
  }

  let artifact: ArtifactInputRef;
  try {
    artifact = artifactStillReady(transaction, projectId, prepared);
  } catch (error) {
    if (isStorageError(error, 'conflict')) return rejected(identity, transaction, { reason: 'candidate_artifact_changed' });
    throw error;
  }
  if (artifact.contentHash !== context.candidateArtifactRef?.contentHash) {
    return rejected(identity, transaction, { reason: 'candidate_artifact_changed' });
  }

  if (snapshot.feature.revision !== envelope.expectedRevision ||
      context.targetRevision !== snapshot.feature.revision ||
      context.planDigest !== snapshot.feature.planDigest) {
    return rejected(identity, transaction, { reason: 'planning_basis_changed' });
  }
  const activeBatch = transaction.getActivePhaseExecutionBatch(projectId, snapshot.feature.phaseId);
  if (activeBatch !== null) {
    return rejected(identity, transaction, { reason: 'active_batch_structure_lock' });
  }
  const activeRun = transaction.getActiveExecutionRun(projectId, snapshot.feature.id);
  if (activeRun !== null) {
    return rejected(identity, transaction, { reason: 'active_execution_inputs' });
  }

  if (envelope.payload.decision === 'reject') {
    const decided = transaction.decidePlanningCandidate({
      projectId,
      candidateId: candidate.candidateId,
      decision: 'rejected',
      reason: envelope.payload.reason,
      appliedRevision: null,
    });
    transaction.appendPlanEvent({
      projectId,
      eventType: FEATURE_PLAN_REJECTED_EVENT_TYPE,
      aggregateType: 'feature',
      aggregateId: snapshot.feature.id,
      aggregateRevision: snapshot.feature.revision,
      payload: { rejected: true },
    });
    const receipt = createCompletedReceipt({
      ...identity,
      resultRef: createResultRef(randomBytes(32)),
      result: {
        decision: 'reject',
        candidateId: candidate.candidateId,
        candidateDigest: candidate.candidateDigest,
        summary: candidate.summary,
        planningContextStatus: decided.status,
        applied: false,
      },
    });
    transaction.saveReceipt(receipt);
    return receipt;
  }

  const candidateTaskIds = new Set(candidate.plan.tasks.map(task => task.id));
  const removedTaskIds = snapshot.tasks.filter(task => !candidateTaskIds.has(task.id)).map(task => task.id);
  const historicalTaskIds = transaction.hasTaskExecutionHistory(projectId, removedTaskIds);
  if (historicalTaskIds.size > 0) {
    return rejected(identity, transaction, { reason: 'historical_task_removal_unsafe' });
  }
  for (const task of snapshot.tasks) {
    if (removedTaskIds.includes(task.id) && task.status !== 'pending') {
      return rejected(identity, transaction, { reason: 'historical_task_removal_unsafe' });
    }
  }

  for (const ref of collectReferences(candidate)) {
    const current = transaction.getArtifactInputRef(projectId, ref.artifactId);
    if (ref.contentHash !== undefined && current.contentHash !== ref.contentHash) {
      return rejected(identity, transaction, { reason: 'artifact_content_hash_mismatch' });
    }
  }

  const globalSettings = transaction.getGlobalSettingsOrNull();
  const projectSettings = transaction.getProjectSettingsOrNull(projectId);
  const selections = new Map<string, ReturnType<typeof selectTaskStrategy>>();
  const existingIds = new Set(snapshot.tasks.map(task => task.id));
  for (const task of candidate.plan.tasks) {
    if (existingIds.has(task.id)) continue;
    try {
      selections.set(task.id, selectTaskStrategy({
        ...(globalSettings === null ? {} : { global: { scopeRevision: globalSettings.revision, payload: globalSettings.payload } }),
        ...(projectSettings === null ? {} : { project: { scopeRevision: projectSettings.revision, payload: projectSettings.payload } }),
        ...(task.complexity === null ? {} : { complexity: task.complexity }),
      }));
    } catch (error) {
      if (error instanceof StorageError) throw mapStorageError(error, { operation: PLANNING_CANDIDATE_DECIDE_OPERATION });
      throw error;
    }
  }

  const replacement = transaction.replaceFeaturePlan({
    projectId,
    featureId: snapshot.feature.id,
    expectedRevision: envelope.expectedRevision,
    feature: {
      title: candidate.plan.feature.title,
      description: candidate.plan.feature.description,
      labels: [...candidate.plan.feature.labels],
      sourceRefs: candidate.plan.feature.sourceRefs.map(ref => ({ ...ref })),
      planDigest: candidate.plan.planDigest,
      planStatus: 'approved',
    },
    tasks: candidate.plan.tasks.map(task => {
      const existing = snapshot.tasks.find(item => item.id === task.id);
      const selected = selections.get(task.id);
      const strategy = selected ?? (existing === undefined ? undefined : {
        executionConfig: existing.executionConfig,
        configSource: existing.configSource,
        configSourceKey: existing.configSourceKey,
      });
      if (strategy === undefined) throw new TypeError(`候选 Task ${task.id} 缺少执行策略`);
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        labels: [...task.labels],
        complexity: task.complexity,
        acceptance: { criteria: [...task.acceptance.criteria] },
        requirementsRefs: task.requirementsRefs.map(ref => ({ ...ref })),
        executionConfig: strategy.executionConfig,
        configSource: strategy.configSource,
        configSourceKey: strategy.configSourceKey,
      };
    }),
    dependencies: candidate.plan.tasks.flatMap(task => task.dependsOn.map(dependsOnId => ({ taskId: task.id, dependsOnId }))),
  });

  const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
    globalSettings === null ? null : { scopeRevision: globalSettings.revision, payload: globalSettings.payload },
    projectSettings === null ? null : { scopeRevision: projectSettings.revision, payload: projectSettings.payload },
  );
  if (transaction.findPlanApproval(projectId, snapshot.feature.id, candidate.plan.planDigest, checkPolicyDigest) !== undefined) {
    return rejected(identity, transaction, { reason: 'approval_already_decided' });
  }
  const approval = transaction.insertPlanApproval({
    projectId,
    subjectType: 'feature_plan',
    subjectId: snapshot.feature.id,
    subjectDigest: candidate.plan.planDigest,
    checkPolicyDigest,
    status: 'approved',
    decisionActor: identity.principalId,
    reason: envelope.payload.reason,
    decidedAtUtcMs: nowUtcMs,
  });
  const decided = transaction.decidePlanningCandidate({
    projectId,
    candidateId: candidate.candidateId,
    decision: 'approved',
    reason: envelope.payload.reason,
    appliedRevision: replacement.feature.revision,
  });
  transaction.appendPlanEvent({
    projectId,
    eventType: FEATURE_PLAN_APPROVED_EVENT_TYPE,
    aggregateType: 'feature',
    aggregateId: replacement.feature.id,
    aggregateRevision: replacement.feature.revision,
    payload: { approved: true },
  });
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      decision: 'approve',
      candidateId: candidate.candidateId,
      candidateDigest: candidate.candidateDigest,
      feature: { id: replacement.feature.id, revision: replacement.feature.revision, planDigest: replacement.feature.planDigest, planStatus: replacement.feature.planStatus },
      application: { createdTaskIds: replacement.createdTaskIds, keptTaskIds: replacement.keptTaskIds, removedTaskIds: replacement.removedTaskIds, planningContextStatus: decided.status },
      verification: candidate.taskVerification.map(intent => ({ ...intent })),
      approval: { id: approval.id, subjectDigest: approval.subjectDigest, checkPolicyDigest: approval.checkPolicyDigest, status: approval.status },
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
