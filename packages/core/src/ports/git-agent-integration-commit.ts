import { createIntegrationExecutionPlan, type IntegrationExecutionPlan, type IntegrationExecutionResult } from './integration-execution-plan.js';
import type { GitOperationIntent } from './git-operations.js';
import type { GitAgentRepairView } from './git-agent-repair-store.js';
import type { IntegrationVerificationEvidenceRef } from './integration-verification.js';
import { StorageError } from './errors.js';
import { validateSha256Digest, validateStableId } from './validation.js';

export interface GitAgentIntegrationCommitBinding {
  readonly repairId: string;
  readonly authorizationDigest: string;
  readonly sourceOperationId: string;
  readonly sourceInputDigest: string;
  readonly parents: readonly string[];
  readonly verification: {
    readonly planRef: IntegrationVerificationEvidenceRef;
    readonly resultRef: IntegrationVerificationEvidenceRef;
  };
}
const oid = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
function fail(): never { throw new StorageError('conflict', 'GitAgentIntegrationCommit', 'Invalid repair commit binding', { details: { reason: 'repair_commit_binding_mismatch' } }); }

/** The durable repair Run distinguishes a repair commit from the original failed operation.
 * Rebuilding the plan after a restart yields the same operation ID, without a new budget grant. */
export function gitAgentIntegrationCommitPlan(repair: GitAgentRepairView, source: IntegrationExecutionPlan): IntegrationExecutionPlan {
  const request = repair.request;
  if (repair.receipt.runId === null || source.integrationId !== request.source.integrationId
    || source.inputDigest !== request.source.inputDigest || source.projectId !== request.projectId
    || source.phaseId !== request.phaseId || source.batchId !== request.parentBatchId
    || source.runId !== request.runId || source.successorFeatureId !== request.featureId
    || source.target.repoIdentity !== request.target.repoIdentity || source.target.baseCommit !== request.target.baselineCommitSha) fail();
  return createIntegrationExecutionPlan({ projectId: source.projectId, phaseId: source.phaseId,
    batchId: source.batchId, runId: repair.receipt.runId, successorFeatureId: source.successorFeatureId,
    target: source.target, predecessors: source.predecessors.map(p => ({ ...p, runId: repair.receipt.runId! })),
    approvedInputs: source.approvedInputs, mergeOrder: source.mergeOrder, verificationScope: source.verificationScope, integrationResult: null });
}

export function readGitAgentIntegrationCommitBinding(intent: Pick<GitOperationIntent, 'operationType' | 'expectedHead' | 'budgetSnapshot' | 'integrationPlan' | 'verificationRefs'>): GitAgentIntegrationCommitBinding | null {
  const value = intent.budgetSnapshot?.gitAgentRepair as GitAgentIntegrationCommitBinding | undefined;
  if (value === undefined) return null;
  if (intent.operationType !== 'integration_commit' || intent.integrationPlan == null || value === null) fail();
  const context = { operation: 'GitAgentIntegrationCommit' };
  validateStableId(value.repairId, context, 'repairId'); validateStableId(value.sourceOperationId, context, 'sourceOperationId');
  validateSha256Digest(value.authorizationDigest, context, 'authorizationDigest'); validateSha256Digest(value.sourceInputDigest, context, 'sourceInputDigest');
  if (!Array.isArray(value.parents) || value.parents.length < 1 || value.parents.length > 2 || value.parents.some(p => !oid(p))
    || new Set(value.parents).size !== value.parents.length || value.parents[0] !== intent.expectedHead
    || value.parents.length === 2 && !intent.integrationPlan.predecessors.some(p => p.delivery?.commitSha === value.parents[1])) fail();
  for (const ref of [value.verification?.planRef, value.verification?.resultRef]) {
    if (!ref) fail(); validateStableId(ref.id, context, 'evidence.id'); validateSha256Digest(ref.digest, context, 'evidence.digest');
  }
  if (!intent.verificationRefs.some(ref => ref.kind === 'verification_result' && ref.id === value.verification.resultRef.id && ref.digest === value.verification.resultRef.digest)
    || !intent.verificationRefs.some(ref => ref.id === value.verification.planRef.id && ref.digest === value.verification.planRef.digest)) fail();
  return value;
}

export function controlledGitCommitLockId(operationId: string): string {
  if (!/^[a-f0-9]{64}$/.test(operationId)) return operationId;
  return `${operationId.slice(0, 8)}-${operationId.slice(8, 12)}-4${operationId.slice(13, 16)}-${((Number.parseInt(operationId.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${operationId.slice(18, 20)}-${operationId.slice(20, 32)}`;
}

export function controlledGitCommitParents(intent: Pick<GitOperationIntent, 'operationType' | 'expectedHead' | 'budgetSnapshot' | 'integrationPlan' | 'verificationRefs'>): readonly string[] {
  return readGitAgentIntegrationCommitBinding(intent)?.parents ?? [intent.expectedHead];
}

export function gitAgentIntegrationCommitResult(intent: GitOperationIntent, commitSha: string, treeSha: string): IntegrationExecutionResult | undefined {
  const binding = readGitAgentIntegrationCommitBinding(intent);
  if (binding === null) return undefined;
  return { commitSha, treeSha, inputDigest: intent.integrationPlan!.inputDigest,
    integrationId: intent.integrationPlan!.integrationId, targetBaseline: intent.integrationPlan!.target.baseCommit,
    verificationEvidence: { evidenceId: binding.verification.resultRef.id, evidenceDigest: binding.verification.resultRef.digest,
      planRef: binding.verification.planRef, resultRef: binding.verification.resultRef } };
}
