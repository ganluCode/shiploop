import type { GitCommitAuthorization, GitCommitFacts } from '../ports/controlled-git-commit.js';
import type { GitAgentRepairView } from '../ports/git-agent-repair-store.js';
import type { GitOperationRecord, GitOperationEvidenceRef } from '../ports/git-operations.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import type { WorkspaceInspection } from '../ports/workspace-inspector.js';
import type { IntegrationRepairVerificationRecord } from '../ports/integration-repair-verification.js';
import { gitAgentIntegrationCommitPlan } from '../ports/git-agent-integration-commit.js';
import { verificationCodeIdentity } from '../ports/verification-aggregate.js';
import { StorageError } from '../ports/errors.js';
import type { PersistedIntegrationPlan } from '../ports/integration-plan-store.js';

export interface IntegrationRepairCommitAuthorizationInput {
  readonly repair: GitAgentRepairView;
  readonly source: GitOperationRecord;
  readonly verification: IntegrationRepairVerificationRecord;
  readonly baseline: WorkspaceBaseline;
  readonly inspection: WorkspaceInspection;
  readonly facts: GitCommitFacts;
  readonly changedPaths: readonly string[];
  readonly attemptId: string;
  readonly ownerId: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly expectedFeatureRevision: number;
  readonly sourcePlan: Pick<PersistedIntegrationPlan, 'integrationId' | 'inputDigest' | 'revision'>;
  readonly mergeParents: readonly string[];
}

function fail(reason: string): never {
  throw new StorageError('conflict', 'IntegrationRepairCommitAuthorization', 'Repair integration authorization rejected', {
    details: { reason },
  });
}

/**
 * Builds the only authorization shape accepted by the controlled integration
 * commit service. Every identity comes from frozen Core facts or the stopped
 * Attempt; Runtime output is never used to choose parents, paths or refs.
 */
export function createIntegrationRepairCommitAuthorization(
  input: IntegrationRepairCommitAuthorizationInput,
): GitCommitAuthorization {
  const { repair, source, verification } = input;
  const sourcePlan = source.intent.integrationPlan;
  if (!sourcePlan || source.intent.projectId !== repair.request.projectId
    || source.intent.operationId !== repair.request.source.operationId
    || source.intentDigest !== repair.request.source.operationDigest) fail('source_identity_changed');
  if (verification.projectId !== repair.request.projectId || verification.repairId !== repair.request.repairId
    || verification.attemptId !== input.attemptId || verification.inputDigest !== sourcePlan.inputDigest) fail('verification_identity_changed');
  const integrationPlan = gitAgentIntegrationCommitPlan(repair, sourcePlan);
  // A repair workspace may already contain target-branch progress after the
  // frozen base. The merge commit must preserve the exact HEAD observed during
  // candidate verification as its first parent.
  if (input.sourcePlan.integrationId !== source.intent.budgetSnapshot?.sourcePlanId) fail('source_plan_changed');
  const attempt=repair.attempts.find(item=>item.id===input.attemptId);
  if (!attempt || attempt.stoppedAtUtcMs===null || attempt.output===null || attempt.ownerId!==input.ownerId
    || attempt.hostInstanceId!==input.hostInstanceId || attempt.authorizationVersion!==input.executionVersion) fail('attempt_identity_changed');
  if (input.mergeParents.some(parent=>!integrationPlan.predecessors.some(p=>p.delivery?.commitSha===parent))) fail('merge_parent_changed');
  const parents = [input.facts.head,...input.mergeParents];
  if (parents.length < 1 || parents.length > 2 || new Set(parents).size !== parents.length) fail('unsupported_parent_set');
  const verificationRefs: readonly GitOperationEvidenceRef[] = [
    { kind: 'artifact', id: verification.planRef.id, digest: verification.planRef.digest },
    { kind: 'verification_result', id: verification.resultRef.id, digest: verification.resultRef.digest },
  ];
  const binding = {
    repairId: repair.request.repairId,
    authorizationDigest: repair.request.authorizationDigest,
    sourceOperationId: repair.request.source.operationId,
    sourceInputDigest: repair.request.source.inputDigest,
    repairAttemptId: input.attemptId,
    repairOwnerId: input.ownerId,
    repairOwnerVersion: input.executionVersion,
    parents,
    verification: { planRef: verification.planRef, resultRef: verification.resultRef },
  };
  const intent = {
    ...source.intent,
    operationId: integrationPlan.integrationId,
    operationType: 'integration_commit' as const,
    attemptId: null,
    executionVersion: input.executionVersion,
    worktreePath: input.baseline.canonicalPath,
    expectedHead: input.facts.head,
    candidateTree: input.facts.tree,
    codeDigest: verificationCodeIdentity(input.inspection).codeDigest,
    verificationRefs,
    integrationPlan,
    budgetSnapshot: { ...(source.intent.budgetSnapshot ?? {}), sourcePlanRevision:input.sourcePlan.revision,
      sourcePlanInputDigest:input.sourcePlan.inputDigest,gitAgentRepair: binding },
    ownerId: input.ownerId,
    hostInstanceId: input.hostInstanceId,
    expectedFeatureRevision: input.expectedFeatureRevision,
  };
  return {
    intent,
    baseline: input.baseline,
    resourceIdentity: {
      projectId: repair.request.projectId,
      attemptId: input.attemptId,
      owner: input.ownerId,
      hostInstanceId: input.hostInstanceId,
      executionVersion: input.executionVersion,
    },
    allowedPaths: [...input.changedPaths].sort(),
    verificationPassed: true,
    approvalCurrent: true,
    finalApprovalCurrent: true,
    commitAuthorized: true,
  };
}
