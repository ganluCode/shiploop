import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import type { IntegrationRepairAuthorizationRecord, IntegrationRepairAuthorizationReceipt, IntegrationRepairFence } from '../../ports/integration-repair-authorization.js';
import type { GitAgentRepairView } from '../../ports/git-agent-repair-store.js';
import { validateGitAgentRepairRequest } from '../../ports/git-agent-repair.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { normalizeFeatureResourceSet, deriveFeatureDispatchResourceSet } from '../../ports/feature-resources.js';
import { validateStableId, validatePositiveInteger, requirePlainObject, rejectUnknownKeys } from '../../ports/validation.js';
import { assertIntegrationResourceFence } from '../../application/integration-resource-fence.js';
import { existingRunBudgetAllowsIntegration } from '../../application/integration-budget.js';
import { gitAgentIntegrationFailureAllowed } from '../../application/git-agent-integration-repair.js';
import { createSqliteFeatureResourceAccess } from './feature-resources.js';
import { createSqliteGitIntegrationJournal } from './git-integration-journal.js';
import { computeGitOperationIntentDigest, validateGitOperationRegisterInput } from '../../ports/git-operations.js';
import type { SqliteStorageSession } from './session.js';
import type { IntegrationClaimRow } from './dag-integration-context.js';

const OP = 'IntegrationRepairAuthorization';
const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
const fail = (reason: string, kind: 'conflict' | 'ownership' | 'not_found' | 'corrupt' = 'conflict'): never => {
  throw new StorageError(kind, OP, 'Integration repair authorization rejected', { details: { reason } });
};
interface Row { project_id: string; repair_id: string; operation_id: string; run_id: string; command_id: string;
  command_digest: string; request: string; fence: string; receipt: string }

/** No queue, model, process, Git, budget reset or resource release. The caller owns the transaction. */
export function createSqliteIntegrationRepairAuthorizations(session: SqliteStorageSession, options: { nowUtcMs?: () => number } = {}) {
  const db = session.database, now = options.nowUtcMs ?? Date.now;
  const resources = createSqliteFeatureResourceAccess(session, options);
  const journal = createSqliteGitIntegrationJournal(session, options);
  function active() { if (!session.isOpen() || !db.inTransaction) throw new TypeError(`${OP} requires CommandTransaction`); }
  function fence(value: IntegrationRepairFence): IntegrationRepairFence {
    const ctx = { operation: OP };
    const raw = requirePlainObject(value, ctx, 'fence');
    rejectUnknownKeys(raw, ['expectedRevision', 'ownerId', 'ownerVersion'], ctx, 'fence');
    return { expectedRevision: validatePositiveInteger(raw.expectedRevision, ctx, 'expectedRevision'),
      ownerId: validateStableId(raw.ownerId, ctx, 'ownerId'), ownerVersion: validatePositiveInteger(raw.ownerVersion, ctx, 'ownerVersion') };
  }
  function decode(row: Row): IntegrationRepairAuthorizationRecord {
    try {
      const request = validateGitAgentRepairRequest(JSON.parse(row.request), { nowUtcMs: 0 });
      const identity = fence(JSON.parse(row.fence));
      const receipt: IntegrationRepairAuthorizationReceipt = { projectId: row.project_id, repairId: row.repair_id, runId: row.run_id,
        operationId: row.operation_id, authorizationDigest: request.authorizationDigest, ownerId: identity.ownerId,
        ownerVersion: identity.ownerVersion, admittedRevision: identity.expectedRevision + 1 };
      if (request.projectId !== row.project_id || request.repairId !== row.repair_id || request.runId !== row.run_id
        || request.source.operationId !== row.operation_id || request.commandId !== row.command_id
        || hash({ request, fence: identity }) !== row.command_digest || !isDeepStrictEqual(JSON.parse(row.receipt), receipt)) fail('authorization_corrupt', 'corrupt');
      return { request, fence: identity, receipt };
    } catch (error) { if (error instanceof StorageError && error.kind === 'corrupt') throw error; return fail('authorization_corrupt', 'corrupt'); }
  }
  return {
    read(_tx: CommandTransaction, projectId: string, repairId: string): IntegrationRepairAuthorizationRecord {
      active(); validateStableId(projectId, { operation: OP }, 'projectId'); validateStableId(repairId, { operation: OP }, 'repairId');
      const row = db.prepare('SELECT * FROM integration_repair_authorizations WHERE project_id=? AND repair_id=?').get(projectId, repairId) as Row | undefined;
      if (!row) return fail('authorization_not_found', 'not_found');
      return decode(row);
    },
    authorize(tx: CommandTransaction, raw: unknown, rawFence: IntegrationRepairFence,
      authorizeCurrent?: () => void): IntegrationRepairAuthorizationReceipt {
      active();
      const request = validateGitAgentRepairRequest(raw, { nowUtcMs: 0 }), identity = fence(rawFence);
      const digest = hash({ request, fence: identity });
      const previous = db.prepare('SELECT * FROM integration_repair_authorizations WHERE project_id=? AND command_id=?')
        .get(request.projectId, request.commandId) as Row | undefined;
      if (previous) {
        if (previous.command_digest !== digest) return fail('command_digest_conflict');
        return decode(previous).receipt;
      }
      if (db.prepare('SELECT repair_id FROM integration_repair_authorizations WHERE project_id=? AND (repair_id=? OR operation_id=?)')
        .get(request.projectId, request.repairId, request.source.operationId)) return fail('repair_identity_conflict');
      const run = tx.getExecutionRun(request.projectId, request.runId), batch = tx.getExecutionBatch(request.projectId, request.parentBatchId);
      const source = tx.getGitOperation(request.projectId, request.source.operationId), binding = tx.getRepositoryBinding(request.projectId);
      const claim = db.prepare('SELECT * FROM integration_execution_claims WHERE project_id=? AND operation_id=?')
        .get(request.projectId, request.source.operationId) as IntegrationClaimRow | undefined;
      if (!claim || claim.run_id !== run.id || claim.admission !== 'owned' || claim.revision !== identity.expectedRevision
        || claim.owner_id !== identity.ownerId || claim.owner_version !== identity.ownerVersion) return fail('integration_owner_or_revision_changed');
      const intent = validateGitOperationRegisterInput(JSON.parse(claim.intent));
      if (source.intentDigest !== computeGitOperationIntentDigest(intent) || intent.projectId !== source.intent.projectId
        || intent.operationId !== source.intent.operationId || intent.runId !== source.intent.runId
        || intent.featureId !== source.intent.featureId || intent.repoIdentity !== source.intent.repoIdentity
        || intent.expectedHead !== source.intent.expectedHead || intent.ownerId !== identity.ownerId
        || intent.budgetSnapshot?.ownerVersion !== identity.ownerVersion) return fail('source_identity_changed');
      if (tx.getProject(request.projectId).status !== 'active' || tx.getPhase(request.projectId, request.phaseId).status !== 'open'
        || batch.phaseId !== request.phaseId || run.batchId !== batch.id || run.featureId !== request.featureId
        || run.purpose !== 'execute' || run.status !== 'queued' || run.startedAtUtcMs !== null
        || !['queued', 'running'].includes(batch.status) || batch.pauseRequestedAtUtcMs !== null || run.pauseRequestedAtUtcMs !== null
        || !tx.listExecutionBatchMemberFeatureIds(request.projectId, batch.id).includes(request.featureId)) return fail('pending_member_required');
      const auth = run.inputSnapshot.integrationAuthorization;
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return fail('integration_authorization_missing');
      const { authorizationDigest, ...material } = auth as Record<string, unknown>;
      if (hash(material) !== authorizationDigest || material.schemaVersion !== 1 || run.inputSnapshot.workspaceBaseline !== undefined
        || material.repositoryBindingId !== binding.id || material.repositoryBindingRevision !== binding.bindingRevision
        || material.repoIdentity !== binding.repoIdentity || material.targetBaseline !== request.target.baselineCommitSha
        || !Array.isArray(material.scopeFeatureIds)
        || !isDeepStrictEqual([...material.scopeFeatureIds].sort(), [...tx.listExecutionBatchMemberFeatureIds(request.projectId, batch.id)].sort())
        || source.intent.repositoryBindingId !== binding.id || source.intent.repoIdentity !== binding.repoIdentity) return fail('frozen_authorization_changed');
      if (!db.prepare("SELECT id FROM command_receipts WHERE project_id=? AND operation='execution.start' AND status='accepted' AND operation_id=?")
        .get(request.projectId, batch.id)) return fail('committed_authorization_required');
      if (db.prepare('SELECT id FROM attempts WHERE project_id=? AND run_id=?').get(request.projectId, run.id)
        || db.prepare('SELECT run_id FROM run_execution_baselines WHERE project_id=? AND run_id=?').get(request.projectId, run.id)
        || db.prepare("SELECT id FROM run_dispatch_claims WHERE project_id=? AND run_id=? AND state<>'released'").get(request.projectId, run.id)) return fail('coding_or_dispatch_already_started');
      const stopped = db.prepare('SELECT stopped FROM integration_processes WHERE project_id=? AND operation_id=?')
        .all(request.projectId, source.intent.operationId) as { stopped: number }[];
      if (stopped.length === 0 || stopped.some(p => p.stopped !== 1)) return fail('integration_stop_unconfirmed');
      const observation = journal.read(tx, request.projectId, source.intent.operationId);
      const evidence = source.status === 'failed' ? request.source.operationId : (db.prepare(`SELECT id FROM git_integration_observations
        WHERE project_id=? AND operation_id=? ORDER BY sequence DESC LIMIT 1`).get(request.projectId, source.intent.operationId) as { id: string } | undefined)?.id;
      const view: GitAgentRepairView = { request, receipt: { repairId: request.repairId, parentBatchId: batch.id,
        runId: run.id, authorizationDigest: request.authorizationDigest, blockedReason: null }, authorizationVersion: batch.budgetRevision,
        blockedReason: null, attempts: [] };
      if (request.source.failureKind !== 'conflict' || evidence === undefined
        || !gitAgentIntegrationFailureAllowed(view, source, observation, false, evidence)) return fail('failure_not_authorized');
      const deadline = Math.min(batch.deadlineAtUtcMs, now() + run.runTimeLimitMs);
      if (!existingRunBudgetAllowsIntegration(batch, run, now()) || batch.attemptsCreated >= batch.budgetSnapshot.batch.maxTotalAttempts
        || batch.runtimeStarts >= batch.budgetSnapshot.batch.maxRuntimeStarts || run.attemptsCreated >= run.maxAttemptsPerRun
        || batch.noProgressRuns >= batch.budgetSnapshot.batch.maxNoProgressRuns || request.budget.deadlineUtcMs > deadline
        || request.budget.deadlineUtcMs <= now() || request.budget.remainingRuntimeMs > Math.min(run.runTimeLimitMs, deadline - now())
        || request.budget.remainingRuntimeMs > request.budget.deadlineUtcMs - now()
        || batch.budgetSnapshot.batch.maxCostTotal !== undefined
        || (batch.budgetSnapshot.batch.maxTokenTotal !== undefined && request.budget.remainingTokens > batch.budgetSnapshot.batch.maxTokenTotal)
        || request.budget.remainingAttempts > run.maxAttemptsPerRun - run.attemptsCreated) return fail('budget_exhausted');
      const resourceSet = normalizeFeatureResourceSet({ projectId: request.projectId, resources: [
        { kind: 'feature_code_shared', key: 'feature-code' }, { kind: 'worktree_write_exclusive', key: `worktree:${request.workspace.workspaceId}` },
        ...deriveFeatureDispatchResourceSet({ projectId: request.projectId, featureId: request.featureId, purpose: 'code', batch }).resources
          .filter(r => r.kind === 'migration' || r.kind === 'contract').map(({ projectId, kind, key }) => ({ projectId, kind, key })),
      ] });
      assertIntegrationResourceFence({ projectId: request.projectId, integrationId: request.workspace.workspaceId, ownerId: identity.ownerId,
        ownerVersion: identity.ownerVersion, resourceSet, leases: resources.listProjectInTransaction(request.projectId) }, now());
      authorizeCurrent?.();
      const receipt: IntegrationRepairAuthorizationReceipt = { projectId: request.projectId, repairId: request.repairId, runId: run.id,
        operationId: source.intent.operationId, authorizationDigest: request.authorizationDigest, ownerId: identity.ownerId,
        ownerVersion: identity.ownerVersion, admittedRevision: identity.expectedRevision + 1 };
      db.prepare(`INSERT INTO integration_repair_authorizations(project_id,repair_id,operation_id,run_id,command_id,command_digest,request,fence,receipt,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(request.projectId, request.repairId, source.intent.operationId, run.id, request.commandId, digest,
          JSON.stringify(request), JSON.stringify(identity), JSON.stringify(receipt), now());
      const result = db.prepare(`UPDATE integration_execution_claims SET revision=revision+1,reason='git_agent_repair_pending'
        WHERE project_id=? AND operation_id=? AND revision=? AND admission='owned' AND owner_id=? AND owner_version=?`)
        .run(request.projectId, source.intent.operationId, identity.expectedRevision, identity.ownerId, identity.ownerVersion);
      if (result.changes !== 1) return fail('integration_owner_or_revision_changed');
      return receipt;
    },
  };
}
