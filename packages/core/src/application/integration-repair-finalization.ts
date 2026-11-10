import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import type { GitCommitDriver, IntegrationCommitResourceFence } from '../ports/controlled-git-commit.js';
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type { GitOperationRecord, GitOperationStore } from '../ports/git-operations.js';
import type { GitAgentRepairHold, GitAgentRepairView } from '../ports/git-agent-repair-store.js';
import type { WorkResourceAccess, WorkResourceSnapshot } from '../ports/work-resources.js';
import type { IntegrationRepairVerificationRecord } from '../ports/integration-repair-verification.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import type { WorkspaceInspection, WorkspaceInspector } from '../ports/workspace-inspector.js';
import type { GitAgentCandidateFinalizationService } from './git-agent-candidate-finalization.js';
import { createControlledGitCommitService } from './controlled-git-commit.js';
import { createGitAgentCandidateFinalizationService, type GitAgentCandidateAuthorizationContext } from './git-agent-candidate-finalization.js';
import { createGitAgentIntegrationEvidencePublisher } from './git-agent-integration-repair.js';
import { createIntegrationRepairCommitAuthorization } from './integration-repair-commit-authorization.js';
import type { PersistedIntegrationPlan } from '../ports/integration-plan-store.js';
import { StorageError } from '../ports/errors.js';
import { isDeepStrictEqual } from 'node:util';

export interface IntegrationRepairFinalizationDependencies {
  readonly atomic: AtomicCommandStore;
  readonly repair: { read(projectId: string, repairId: string): GitAgentRepairView; hold(projectId: string, repairId: string, reason: GitAgentRepairHold): unknown };
  readonly operations: GitOperationStore;
  readonly inspector: WorkspaceInspector;
  readonly driver: GitCommitDriver;
  readonly lock: GitPublicMetadataLock;
  readonly resources: Pick<WorkResourceAccess, 'read'>;
  readonly integrationResources: IntegrationCommitResourceFence;
  readonly readSource: (repair: GitAgentRepairView) => GitOperationRecord;
  readonly readSourcePlan: (repair: GitAgentRepairView) => PersistedIntegrationPlan;
  readonly readVerification: (repair: GitAgentRepairView) => IntegrationRepairVerificationRecord;
  readonly readBaseline: (repair: GitAgentRepairView) => WorkspaceBaseline;
  readonly readBefore: (repair: GitAgentRepairView) => WorkspaceInspection;
  readonly expectedFeatureRevision: (repair: GitAgentRepairView) => number;
  readonly assertCurrent: (repair: GitAgentRepairView, operation: GitOperationRecord | null) => boolean;
  readonly authorize: (tx: CommandTransaction, repair: GitAgentRepairView, operation: GitOperationRecord) => boolean;
  readonly nowUtcMs?: () => number;
}

export function createIntegrationRepairFinalizationService(deps: IntegrationRepairFinalizationDependencies): GitAgentCandidateFinalizationService {
  const now = deps.nowUtcMs ?? Date.now;
  let authorized: ReturnType<typeof createIntegrationRepairCommitAuthorization> | null = null;
  let authorizedRepair: GitAgentRepairView | null = null;
  let mergeParents: readonly string[] | null = null;
  const readAuthorization = (context: GitAgentCandidateAuthorizationContext) => {
    authorized = createIntegrationRepairCommitAuthorization({
      repair: context.repair,
      source: deps.readSource(context.repair),
      verification: deps.readVerification(context.repair),
      baseline: context.baseline,
      inspection: context.inspection,
      facts: context.facts,
      changedPaths: context.commitPaths,
      attemptId: context.attempt.id,
      ownerId: context.attempt.ownerId,
      hostInstanceId: context.attempt.hostInstanceId,
      executionVersion: context.attempt.authorizationVersion,
      expectedFeatureRevision: deps.expectedFeatureRevision(context.repair),
      sourcePlan: deps.readSourcePlan(context.repair),
      mergeParents: mergeParents ?? (()=>{throw new Error('merge_parents_unavailable');})(),
    });
    authorizedRepair=structuredClone(context.repair);
    return authorized;
  };
  const commit = createControlledGitCommitService({
    operations: deps.operations,
    inspector: deps.inspector,
    driver: deps.driver,
    lock: deps.lock,
    resources: deps.resources,
    integrationResources: deps.integrationResources,
    stopVerifier: { verify: async () => ({}), inspect: snapshot => snapshot as WorkResourceSnapshot },
    readAuthorization: request => {
      if (authorized !== null && authorizedRepair!==null && authorized.intent.projectId === request.projectId && authorized.intent.operationId === request.operationId) {
        if (!deps.assertCurrent(authorizedRepair,null)
          || !isDeepStrictEqual(deps.repair.read(request.projectId,authorizedRepair.request.repairId),authorizedRepair)
          || deps.expectedFeatureRevision(authorizedRepair)!==authorized.intent.expectedFeatureRevision) {
          throw new StorageError('conflict','IntegrationRepairFinalization','authorization_not_current',{details:{reason:'authorization_not_current'}});
        }
        return authorized;
      }
      throw new Error('integration_authorization_not_bound');
    },
    transact: callback => deps.atomic.transact('IntegrationRepairFinalization.commit', callback),
    excludedPaths: ['.shiploop'],
    nowMs: now,
  });
  return createGitAgentCandidateFinalizationService({
    repair: deps.repair,
    inspector: deps.inspector,
    driver: deps.driver,
    readBaseline: (_request, repair) => deps.readBaseline(repair),
    readAuthorization,
    verify: async input => {
      const git=deps.driver.open(input.baseline,()=>{});
      if (!git.mergeHeads) throw new Error('merge_parents_unavailable');
      mergeParents=await git.mergeHeads();
      const verification = deps.readVerification(deps.repair.read(input.request.projectId, input.request.repairId));
      if (verification.inputDigest !== input.request.source.inputDigest) {
        return { outcome: 'failed' as const, evidence: null, reason: 'input_digest_mismatch', hold: 'identity_or_lock' as const };
      }
      return { outcome: 'passed' as const,
        evidence: { kind: 'verification_result' as const, id: verification.resultRef.id, digest: verification.resultRef.digest },
        planEvidence: { kind: 'artifact' as const, id: verification.planRef.id, digest: verification.planRef.digest },
        reason: null, hold: null };
    },
    commit,
    operations: deps.operations,
    integration: {
      readContext: repair => ({ source: deps.readSource(repair), before: deps.readBefore(repair) }),
      assertCurrent: deps.assertCurrent,
      publish: async (repair, operation) => createGitAgentIntegrationEvidencePublisher({
        atomic: deps.atomic,
        repair: deps.repair,
        verify: async candidate => {
          const verification = deps.readVerification(candidate);
          const refs = operation.integrationResult?.verificationEvidence;
          return refs?.resultRef?.digest === verification.resultRef.digest && refs.planRef?.digest === verification.planRef.digest;
        },
        authorize: deps.authorize,
        nowUtcMs: now,
      }).publish(repair, operation),
    },
  });
}
