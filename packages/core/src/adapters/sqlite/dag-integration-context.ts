import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import type { SqliteStorageSession } from './session.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { verifyFeaturePlanApprovalInTransaction } from '../../application/plan-approval-verification.js';
import { mergeEffectiveSettings } from '../../application/effective-settings.js';
import { existingRunBudgetAllowsIntegration } from '../../application/integration-budget.js';
import { buildVerificationPlan } from '../../application/verification-plan.js';
import { computeDeliveryPolicyDigest, resolveDeliveryPolicyForUse } from '../../ports/delivery-policy.js';
import { normalizeFeatureResourceSet, deriveFeatureDispatchResourceSet } from '../../ports/feature-resources.js';
import { validateGitOperationRegisterInput } from '../../ports/git-operations.js';
import type { GitOperationRegisterInput } from '../../ports/git-operations.js';
import { assertIntegrationResourceFence } from '../../application/integration-resource-fence.js';
import { createSqliteVerificationStore } from './verification-store.js';
import { createSqliteFeatureResourceAccess } from './feature-resources.js';

export const integrationHash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
export function integrationFailure(reason: string): never {
  throw new StorageError('conflict', 'DagIntegration', 'Integration is blocked', { details: { reason } });
}

export interface IntegrationClaimRow {
  project_id: string; operation_id: string; run_id: string; source_plan_id: string; owner_id: string; owner_version: number;
  intent: string; admission: 'owned' | 'quarantined' | 'settled'; verification_started: number;
  verification_result: string | null; revision: number; reason: string | null;
}

/** No Git, files, SDK or waits; every returned fact belongs to this same Core transaction. */
export function createSqliteDagIntegrationContext(session: SqliteStorageSession, options: { nowUtcMs?: () => number } = {}) {
  const db = session.database, now = options.nowUtcMs ?? Date.now;
  const atomic = createSqliteAtomicCommandStore(session, options);
  const resources = createSqliteFeatureResourceAccess(session, options);
  const verification = createSqliteVerificationStore(session, options);
  function read(tx: CommandTransaction, projectId: string, runId: string) {
    const run = tx.getExecutionRun(projectId, runId), batch = tx.getExecutionBatch(projectId, run.batchId);
    const feature = tx.getFeaturePlan(projectId, run.featureId).feature;
    if (tx.getProject(projectId).status !== 'active' || tx.getPhase(projectId, batch.phaseId).status !== 'open'
      || !['queued','running'].includes(run.status) || !['queued','running'].includes(batch.status)
      || run.pauseRequestedAtUtcMs !== null || batch.pauseRequestedAtUtcMs !== null || feature.phaseId !== batch.phaseId
      || !tx.listExecutionBatchMemberFeatureIds(projectId, batch.id).includes(feature.id)) integrationFailure('execution_not_current');
    if (!db.prepare(`SELECT id FROM command_receipts WHERE project_id=? AND operation='execution.start'
      AND status='accepted' AND operation_id=? LIMIT 1`).get(projectId, batch.id)) integrationFailure('committed_authorization_required');
    const raw = run.inputSnapshot.integrationAuthorization;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) integrationFailure('integration_authorization_missing');
    const auth = raw as { schemaVersion: number; authorizationDigest: string; targetBaseline: string; repoIdentity: string;
      repositoryBindingId: string; repositoryBindingRevision: number; scopeFeatureIds: string[]; dagDigest: string;
      dependencies: { featureId: string; dependsOnId: string; revision: number | null }[] };
    const { authorizationDigest, ...material } = auth;
    if (auth.schemaVersion !== 1 || integrationHash(material) !== authorizationDigest || !/^[a-f0-9]{64}$/.test(authorizationDigest)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(auth.targetBaseline)) integrationFailure('authorization_digest_mismatch');
    const members = tx.listExecutionBatchMemberFeatureIds(projectId, batch.id);
    if (!isDeepStrictEqual([...members].sort(), [...auth.scopeFeatureIds].sort())) integrationFailure('batch_scope_changed');
    const binding = tx.getRepositoryBinding(projectId);
    if (binding.id !== auth.repositoryBindingId || binding.bindingRevision !== auth.repositoryBindingRevision
      || binding.repoIdentity !== auth.repoIdentity || !binding.gitCommonDir) integrationFailure('repo_identity_changed');
    const edges = db.prepare(`SELECT feature_id,depends_on_id,revision FROM feature_dependencies
      WHERE project_id=? AND feature_id=? ORDER BY depends_on_id`).all(projectId, feature.id) as
      { feature_id: string; depends_on_id: string; revision: number }[];
    const frozen = auth.dependencies.map(edge => ({ featureId: edge.featureId, dependsOnId: edge.dependsOnId, revision: edge.revision })).sort((a,b)=>a.dependsOnId.localeCompare(b.dependsOnId));
    if (!edges.length || !isDeepStrictEqual(edges.map(edge => ({ featureId: edge.feature_id, dependsOnId: edge.depends_on_id, revision: edge.revision })), frozen)) integrationFailure('dependency_edges_changed');
    const approval = verifyFeaturePlanApprovalInTransaction(tx, projectId, feature.id);
    const frozenApproval = batch.configSnapshot.approval as { checkPolicyDigest?: unknown };
    if (!approval.validity.valid || approval.planDigest !== run.inputSnapshot.planDigest
      || approval.checkPolicyDigest !== frozenApproval?.checkPolicyDigest) integrationFailure('approval_not_current');
    if (db.prepare(`SELECT id FROM tasks WHERE project_id=? AND feature_id=? AND manual_block<>0 LIMIT 1`).get(projectId,feature.id)) integrationFailure('manual_block');
    const global = tx.getGlobalSettingsOrNull(), project = tx.getProjectSettingsOrNull(projectId);
    const settings = mergeEffectiveSettings({ global: global && { scopeRevision: global.revision, payload: global.payload },
      project: project && { scopeRevision: project.revision, payload: project.payload } });
    const policy = buildVerificationPlan({ policy: settings.policies.verification?.value, changedPaths: [], candidate: null });
    if (policy.status !== 'ready' || policy.selectedChecks.length === 0) integrationFailure('verification_plan_unavailable');
    const delivery = resolveDeliveryPolicyForUse(settings.policies.deliveryPolicy?.value);
    if (delivery.status !== 'ready') integrationFailure(delivery.reason);
    const deadlineUtcMs = Math.min(batch.deadlineAtUtcMs, run.startedAtUtcMs === null ? batch.deadlineAtUtcMs : run.startedAtUtcMs + run.runTimeLimitMs);
    if (!existingRunBudgetAllowsIntegration(batch,run,now()) || deadlineUtcMs <= now()) integrationFailure('budget_exhausted');
    const predecessors = edges.map(edge => {
      const parent = tx.getFeaturePlan(projectId, edge.depends_on_id).feature;
      if (parent.phaseId !== batch.phaseId || parent.status !== 'completed' || parent.deliveryStatus !== 'succeeded') integrationFailure('dependency_pending');
      const row = db.prepare(`SELECT id FROM git_operations WHERE project_id=? AND feature_id=?
        AND operation_type='feature_final_commit' AND status IN ('succeeded','no_change') ORDER BY settled_at DESC,id DESC LIMIT 1`)
        .get(projectId,parent.id) as { id: string } | undefined;
      if (!row) integrationFailure('missing_delivery_evidence');
      const operation = tx.getGitOperation(projectId,row!.id);
      if (!operation.receipt || !operation.actualCommit || !operation.actualTree || operation.intent.repoIdentity !== binding.repoIdentity
        || operation.intent.repositoryBindingId !== binding.id || !operation.intent.verificationRefs.some(ref=>ref.kind==='verification_batch')) integrationFailure('missing_delivery_evidence');
      const parentRun = tx.getExecutionRun(projectId,operation.intent.runId);
      const parentApproval=verifyFeaturePlanApprovalInTransaction(tx,projectId,parent.id);
      if (parentRun.featureId !== parent.id || parentRun.status !== 'succeeded' || !parentApproval.validity.valid
        || parentApproval.planDigest!==parentRun.inputSnapshot.planDigest) integrationFailure('delivery_not_current');
      for(const ref of operation.intent.verificationRefs) if(ref.kind==='verification_batch') {
        const evidence=verification.getVerificationBatch(projectId,ref.id);
        if(evidence.status!=='passed'||evidence.featureId!==parent.id||evidence.runId!==parentRun.id
          || evidence.policyDigest!==parentApproval.checkPolicyDigest) integrationFailure('delivery_not_current');
      }
      return { feature: parent, operation, run: parentRun, evidenceDigest: integrationHash(operation.receipt) };
    });
    const resourceSet = normalizeFeatureResourceSet({ projectId, resources: [
      { kind: 'feature_code_shared', key: 'feature-code' },
      ...deriveFeatureDispatchResourceSet({ projectId,featureId:feature.id,purpose:'code',batch }).resources
        .filter(resource=>resource.kind==='migration'||resource.kind==='contract')
        .map(({projectId:_project,accessMode:_access,leaseMode:_lease,...resource})=>resource),
    ] });
    return { projectId, run, batch, feature, auth, binding, approval, settings, policy, delivery: delivery.policy,
      deliveryPolicyDigest: computeDeliveryPolicyDigest(settings.policies.deliveryPolicy?.value), deadlineUtcMs, predecessors, resourceSet };
  }
  function claim(projectId:string, operationId:string) {
    const row=db.prepare('SELECT * FROM integration_execution_claims WHERE project_id=? AND operation_id=?').get(projectId,operationId) as IntegrationClaimRow|undefined;
    if (!row) integrationFailure('integration_claim_missing');
    const intent=validateGitOperationRegisterInput(JSON.parse(row!.intent));
    return { row:row!, intent };
  }
  function authorize(tx:CommandTransaction, projectId:string, operationId:string) {
    const {row,intent}=claim(projectId,operationId);
    if (row.admission!=='owned') integrationFailure(row.reason ?? 'integration_quarantined');
    const current=read(tx,projectId,row.run_id);
    const plan=intent.integrationPlan!;
    if (intent.expectedFeatureRevision!==current.feature.revision || plan.successorFeatureId!==current.feature.id
      || plan.target.repoIdentity!==current.binding.repoIdentity || plan.batchId!==current.batch.id
      || current.approval.checkPolicyDigest!==intent.budgetSnapshot?.checkPolicyDigest
      || current.deliveryPolicyDigest!==intent.deliveryPolicyDigest
      || !isDeepStrictEqual([...current.policy.selectedCheckKeys].sort(),[...plan.verificationScope].sort())) integrationFailure('authorization_changed');
    const revisions=intent.budgetSnapshot!.predecessorRevisions as Record<string,number>;
    const origins=intent.budgetSnapshot!.predecessorRuns as Record<string,{batchId:string;runId:string}> | undefined;
    for(const predecessor of current.predecessors) {
      const origin=origins?.[predecessor.feature.id];
      if(!origin || origin.batchId!==predecessor.run.batchId || origin.runId!==predecessor.run.id) integrationFailure('predecessor_changed');
      const old=plan.predecessors.find(item=>item.featureId===predecessor.feature.id);
      if(!old || old.delivery?.commitSha!==predecessor.operation.actualCommit || old.delivery?.evidenceDigest!==predecessor.evidenceDigest
        || revisions[predecessor.feature.id]!==predecessor.feature.revision) integrationFailure('predecessor_changed');
    }
    const resourceSet=normalizeFeatureResourceSet({projectId,resources:[
      ...current.resourceSet.resources.map(({accessMode:_a,leaseMode:_l,...resource})=>resource),
      {kind:'worktree_write_exclusive',key:`worktree:${plan.integrationId}`},
    ]});
    const leases=resources.listProjectInTransaction(projectId);
    assertIntegrationResourceFence({projectId,integrationId:plan.integrationId,ownerId:row.owner_id,ownerVersion:row.owner_version,resourceSet,leases},now());
    return { current,row,intent,resourceSet,leases };
  }
  return { atomic,resources,read,claim,authorize,snapshot:(projectId:string,runId:string)=>atomic.transact('DagIntegration.snapshot',tx=>read(tx,projectId,runId)) };
}
