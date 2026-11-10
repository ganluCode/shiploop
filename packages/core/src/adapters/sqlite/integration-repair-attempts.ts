import { validateGitAgentRuntimeRequest } from '../../ports/git-agent-runtime.js';
import { validateGitAgentRepairRequest, validateGitAgentRepairRuntimeOutput } from '../../ports/git-agent-repair.js';
import { validateStableId, validatePositiveInteger } from '../../ports/validation.js';
import { StorageError } from '../../ports/errors.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import type { IntegrationRepairAttemptClaim, IntegrationRepairAttemptRecord } from '../../ports/integration-repair-attempt.js';
import type { GitAgentRuntimeRequest } from '../../ports/git-agent-runtime.js';
import type { SqliteStorageSession } from './session.js';
import { createSqliteIntegrationRepairAuthorizations } from './integration-repair-authorizations.js';
import { createSqliteExecutionSlotAccess } from './execution-slots.js';
import { resolveApprovedBatchConcurrency } from '../../ports/feature-dispatch.js';
import { createSqliteFeatureResourceAccess } from './feature-resources.js';
import { normalizeFeatureResourceSet, deriveFeatureDispatchResourceSet } from '../../ports/feature-resources.js';
import { assertIntegrationResourceFence } from '../../application/integration-resource-fence.js';
import { validateTaskClaimDispatch } from '../../ports/task-claim.js';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { integrationRepairReservedTokens } from './integration-repair-budget.js';
import { validateWorkProcessIdentity } from '../../ports/work-resources.js';

const OP = 'IntegrationRepairAttempt';
const fail = (reason: string, kind: 'conflict' | 'not_found' | 'corrupt' = 'conflict'): never => {
  throw new StorageError(kind, OP, 'Integration repair attempt rejected', { details: { reason } });
};
type Row = { project_id: string; attempt_id: string; repair_id: string; run_id: string; operation_id: string; owner_id: string; host_instance_id: string;
  execution_version: number; request: string; runtime_request: string | null; dispatch: string; process_identity: string | null; started_at: number; deadline_at: number; max_tokens: number; max_runtime_ms: number; output: string | null; stopped_at: number | null };

export function createSqliteIntegrationRepairAttempts(session: SqliteStorageSession, options: { nowUtcMs?: () => number } = {}) {
  const db = session.database, now = options.nowUtcMs ?? Date.now;
  const authorizations = createSqliteIntegrationRepairAuthorizations(session, options);
  function active() { if (!session.isOpen() || !db.inTransaction) throw new TypeError(`${OP} requires CommandTransaction`); }
  function identity(value: IntegrationRepairAttemptClaim): IntegrationRepairAttemptClaim {
    validateStableId(value.projectId, { operation: OP }, 'projectId'); validateStableId(value.repairId, { operation: OP }, 'repairId');
    validateStableId(value.attemptId, { operation: OP }, 'attemptId'); validateStableId(value.ownerId, { operation: OP }, 'ownerId');
    validateStableId(value.hostInstanceId, { operation: OP }, 'hostInstanceId'); validatePositiveInteger(value.executionVersion, { operation: OP }, 'executionVersion');
    return value;
  }
  function row(claim: IntegrationRepairAttemptClaim): Row | undefined {
    return db.prepare('SELECT * FROM integration_repair_attempts WHERE project_id=? AND repair_id=?').get(claim.projectId, claim.repairId) as Row | undefined;
  }
  function decode(value: Row): IntegrationRepairAttemptRecord {
    try {
      const request = validateGitAgentRepairRequest(JSON.parse(value.request), { nowUtcMs: 0 });
      return { projectId: value.project_id, repairId: value.repair_id, attemptId: value.attempt_id, runId: value.run_id,
        operationId: value.operation_id, ownerId: value.owner_id, hostInstanceId: value.host_instance_id, executionVersion: value.execution_version,
        request, runtimeRequest: value.runtime_request === null ? null : validateGitAgentRuntimeRequest(JSON.parse(value.runtime_request)),
        processIdentity: value.process_identity === null ? null : validateWorkProcessIdentity(JSON.parse(value.process_identity)),
        dispatch: validateTaskClaimDispatch(JSON.parse(value.dispatch)), startedAtUtcMs: value.started_at, deadlineUtcMs: value.deadline_at, maxTokens: value.max_tokens,
        maxRuntimeMs: value.max_runtime_ms, output: value.output === null ? null : validateGitAgentRepairRuntimeOutput(JSON.parse(value.output), request),
        stoppedAtUtcMs: value.stopped_at };
    } catch (error) { throw new StorageError('corrupt', OP, 'Invalid persisted integration repair attempt', { cause: error }); }
  }
  function currentOwner(attempt: IntegrationRepairAttemptRecord) {
    const held = db.prepare(`SELECT c.operation_id FROM integration_execution_claims c JOIN run_dispatch_claims d
      ON d.project_id=c.project_id AND d.run_id=c.run_id JOIN execution_slot_claims s ON s.claim_id=d.id
      WHERE c.project_id=? AND c.operation_id=? AND c.owner_id=? AND c.admission='owned'
      AND d.id=? AND d.claim_version=? AND d.owner_id=? AND d.host_instance_id=? AND d.state='held'
      AND s.id=? AND s.state='held' AND s.owner_id=d.owner_id AND s.host_instance_id=d.host_instance_id`)
      .get(attempt.projectId,attempt.operationId,attempt.ownerId,attempt.dispatch.claimId,attempt.dispatch.claimVersion,
        attempt.ownerId,attempt.hostInstanceId,attempt.dispatch.slotId);
    if (!held) fail('attempt_owner_changed');
  }
  return {
    read(tx: CommandTransaction, claim: IntegrationRepairAttemptClaim): IntegrationRepairAttemptRecord {
      active(); identity(claim); const value = row(claim); if (!value) fail('attempt_not_found', 'not_found');
      if (value!.attempt_id !== claim.attemptId || value!.owner_id !== claim.ownerId || value!.host_instance_id !== claim.hostInstanceId || value!.execution_version !== claim.executionVersion) fail('attempt_owner_changed');
      return decode(value!);
    },
    claim(tx: CommandTransaction, claim: IntegrationRepairAttemptClaim): { attempt: IntegrationRepairAttemptRecord; fresh: boolean } {
      active(); identity(claim);
      const authorization = authorizations.read(tx, claim.projectId, claim.repairId);
      const previous = row(claim);
      if (previous) {
        if (previous.attempt_id !== claim.attemptId || previous.owner_id !== claim.ownerId || previous.host_instance_id !== claim.hostInstanceId
          || previous.execution_version !== claim.executionVersion) fail('attempt_identity_conflict');
        return { attempt: decode(previous), fresh: false };
      }
      if (authorization.fence.ownerId !== claim.ownerId) fail('authorization_owner_changed');
      const request = authorization.request;
      const run = tx.getExecutionRun(claim.projectId, request.runId), batch = tx.getExecutionBatch(claim.projectId, request.parentBatchId);
      const nowValue = now(), deadline = Math.min(request.budget.deadlineUtcMs, nowValue + request.budget.remainingRuntimeMs, batch.deadlineAtUtcMs,
        run.startedAtUtcMs === null ? nowValue + run.runTimeLimitMs : run.startedAtUtcMs + run.runTimeLimitMs);
      if (deadline <= nowValue || request.budget.remainingTokens < 1 || request.budget.remainingAttempts < 1) fail('budget_exhausted');
      if (run.status !== 'queued' || run.startedAtUtcMs !== null || run.pauseRequestedAtUtcMs !== null
        || !['queued','running'].includes(batch.status) || batch.pauseRequestedAtUtcMs !== null
        || run.featureId !== request.featureId || run.batchId !== batch.id || run.purpose !== 'execute'
        || tx.getProject(claim.projectId).status !== 'active' || tx.getPhase(claim.projectId, request.phaseId).status !== 'open') fail('pending_member_required');
      const integration = db.prepare('SELECT owner_id,owner_version,revision,admission FROM integration_execution_claims WHERE project_id=? AND operation_id=?')
        .get(claim.projectId, authorization.receipt.operationId) as { owner_id: string; owner_version: number; revision: number; admission: string } | undefined;
      if (!integration || integration.owner_id !== claim.ownerId || integration.owner_version !== authorization.fence.ownerVersion
        || integration.revision !== authorization.receipt.admittedRevision || integration.admission !== 'owned') fail('integration_owner_changed');
      if (db.prepare('SELECT id FROM attempts WHERE project_id=? AND run_id=?').get(claim.projectId, run.id)
        || db.prepare('SELECT run_id FROM run_execution_baselines WHERE project_id=? AND run_id=?').get(claim.projectId, run.id)) fail('coding_already_started');
      if (db.prepare('SELECT launch_id FROM integration_processes WHERE project_id=? AND operation_id=? AND stopped=0').get(claim.projectId, request.source.operationId)) fail('stop_unconfirmed');
      const resourceSet = normalizeFeatureResourceSet({ projectId: claim.projectId, resources: [
        { kind: 'feature_code_shared', key: 'feature-code' }, { kind: 'worktree_write_exclusive', key: `worktree:${request.workspace.workspaceId}` },
        ...deriveFeatureDispatchResourceSet({ projectId: claim.projectId, featureId: request.featureId, purpose: 'code', batch }).resources
          .filter(r => r.kind === 'migration' || r.kind === 'contract').map(({ projectId, kind, key }) => ({ projectId, kind, key })),
      ] });
      assertIntegrationResourceFence({ projectId: claim.projectId, integrationId: request.workspace.workspaceId, ownerId: claim.ownerId,
        ownerVersion: integration!.owner_version, resourceSet, leases: createSqliteFeatureResourceAccess(session, options).listProjectInTransaction(claim.projectId) }, nowValue);
      const limit = batch.budgetSnapshot.batch;
      if (batch.attemptsCreated >= limit.maxTotalAttempts || batch.runtimeStarts >= limit.maxRuntimeStarts
        || batch.noProgressRuns >= limit.maxNoProgressRuns || run.attemptsCreated >= run.maxAttemptsPerRun || limit.maxCostTotal !== undefined) fail('budget_exhausted');
      let tokens = request.budget.remainingTokens;
      if (limit.maxTokenTotal !== undefined) {
        let used = integrationRepairReservedTokens(session, claim.projectId, batch.id);
        for (const row of db.prepare('SELECT a.usage_summary FROM attempts a JOIN runs r ON r.id=a.run_id WHERE a.project_id=? AND r.batch_id=?').all(claim.projectId,batch.id) as {usage_summary:string|null}[]) {
          const usage = row.usage_summary === null ? null : JSON.parse(row.usage_summary);
          if (!Number.isSafeInteger(usage?.inputTokens) || !Number.isSafeInteger(usage?.outputTokens)
            || usage.inputTokens < 0 || usage.outputTokens < 0) fail('usage_unknown');
          used += usage.inputTokens + usage.outputTokens;
        }
        for (const row of db.prepare('SELECT a.token_limit AS amount FROM feature_repair_attempts a JOIN runs r ON r.id=a.run_id WHERE a.project_id=? AND r.batch_id=?').all(claim.projectId,batch.id) as {amount:number}[]) used += row.amount;
        for (const row of db.prepare('SELECT a.max_tokens AS amount FROM git_agent_repair_attempts a JOIN runs r ON r.id=a.run_id WHERE a.project_id=? AND r.batch_id=?').all(claim.projectId,batch.id) as {amount:number}[]) used += row.amount;
        if (!Number.isSafeInteger(used) || used >= limit.maxTokenTotal) fail('budget_exhausted');
        tokens = Math.min(tokens, limit.maxTokenTotal-used);
      }
      const claimId = randomUUID();
      if (db.prepare("SELECT id FROM run_dispatch_claims WHERE project_id=? AND run_id=? AND state<>'released'").get(claim.projectId,run.id)) fail('dispatch_already_held');
      if (db.prepare('SELECT id FROM run_dispatch_claims WHERE project_id=? AND run_id=?').get(claim.projectId,run.id)) fail('dispatch_recovery_required');
      db.prepare(`INSERT INTO run_dispatch_claims(id,created_at,project_id,revision,updated_at,feature_id,run_id,claim_version,origin,owner_id,host_instance_id,acquired_at,lease_until,state)
        VALUES(?,?,?,1,?,?,?,1,'dispatch',?,?,?,?,'held')`).run(claimId,nowValue,claim.projectId,nowValue,request.featureId,run.id,claim.ownerId,claim.hostInstanceId,nowValue,deadline);
      const slot = createSqliteExecutionSlotAccess(session,{ nowUtcMs: now, capacity: resolveApprovedBatchConcurrency(batch.configSnapshot) })
        .acquireInTransaction({ projectId: claim.projectId, featureId: request.featureId, runId: run.id, claimId, claimVersion: 1,
          ownerId: claim.ownerId, hostInstanceId: claim.hostInstanceId, leaseUntilUtcMs: deadline });
      const dispatch = { claimId, claimVersion: 1, slotId: slot.id };
      tx.reserveRuntimeStart({projectId:claim.projectId,batchId:batch.id,runId:run.id,startKey:claim.attemptId});
      db.prepare('UPDATE execution_batches SET attempts_created=attempts_created+1,revision=revision+1,updated_at=? WHERE project_id=? AND id=?')
        .run(nowValue,claim.projectId,batch.id);
      db.prepare('UPDATE runs SET attempts_created=attempts_created+1,revision=revision+1,updated_at=? WHERE project_id=? AND id=?')
        .run(nowValue,claim.projectId,run.id);
      db.prepare(`INSERT INTO integration_repair_attempts(project_id,attempt_id,repair_id,run_id,operation_id,owner_id,host_instance_id,execution_version,request,runtime_request,dispatch,started_at,deadline_at,max_tokens,max_runtime_ms)
        VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?)`).run(claim.projectId, claim.attemptId, claim.repairId, authorization.receipt.runId,
          authorization.receipt.operationId, claim.ownerId, claim.hostInstanceId, claim.executionVersion, JSON.stringify(request), JSON.stringify(dispatch), nowValue, deadline,
          tokens, deadline-nowValue);
      return { attempt: decode(row(claim)!), fresh: true };
    },
    bind(tx: CommandTransaction, claim: IntegrationRepairAttemptClaim, runtimeRequest: GitAgentRuntimeRequest): IntegrationRepairAttemptRecord {
      active(); const current = this.read(tx, claim); const validated = validateGitAgentRuntimeRequest(runtimeRequest);
      if (current.runtimeRequest && !isDeepStrictEqual(current.runtimeRequest, validated)) fail('runtime_request_conflict');
      const { schemaVersion: _s, authorizationDigest: _a, commandDigest: _c, budget: _b, ...original } = current.request;
      const { schemaVersion: _rs, authorizationDigest: _ra, commandDigest: _rc, budget, ...bound } = validated.authorization;
      if (validated.execution.attemptId !== current.attemptId || validated.execution.ownerId !== current.ownerId
        || validated.execution.hostInstanceId !== current.hostInstanceId || validated.execution.executionVersion !== current.executionVersion
        || validated.authorization.projectId !== current.projectId || validated.authorization.repairId !== current.repairId
        || !isDeepStrictEqual(original, bound) || budget.remainingAttempts !== 1
        || validated.authorization.budget.remainingTokens !== current.maxTokens || validated.authorization.budget.remainingRuntimeMs > current.maxRuntimeMs
        || validated.authorization.budget.deadlineUtcMs !== current.deadlineUtcMs) fail('runtime_request_identity_mismatch');
      if (!current.runtimeRequest && (current.stoppedAtUtcMs !== null || current.output !== null || now() >= current.deadlineUtcMs
        || budget.remainingRuntimeMs > current.deadlineUtcMs - now())) fail('budget_exhausted');
      currentOwner(current);
      if (!current.runtimeRequest) db.prepare('UPDATE integration_repair_attempts SET runtime_request=? WHERE project_id=? AND attempt_id=?').run(JSON.stringify(validated), claim.projectId, claim.attemptId);
      return decode(row(claim)!);
    },
    confirmProcess(tx: CommandTransaction, claim: IntegrationRepairAttemptClaim, value: unknown) {
      active(); const current = this.read(tx, claim), process = validateWorkProcessIdentity(value);
      currentOwner(current);
      if (!current.runtimeRequest || current.output !== null || current.stoppedAtUtcMs !== null || now() >= current.deadlineUtcMs) fail('process_confirmation_not_current');
      if (current.processIdentity) {
        if (!isDeepStrictEqual(current.processIdentity, process)) fail('process_identity_conflict');
        return { launchId: process.launchId };
      }
      db.prepare('INSERT INTO integration_processes(project_id,operation_id,launch_id,process_identity,stopped,created_at) VALUES(?,?,?,?,0,?)')
        .run(claim.projectId,current.operationId,process.launchId,JSON.stringify(process),now());
      db.prepare('UPDATE integration_repair_attempts SET process_identity=? WHERE project_id=? AND attempt_id=?')
        .run(JSON.stringify(process),claim.projectId,claim.attemptId);
      return { launchId: process.launchId };
    },
    settle(tx: CommandTransaction, claim: IntegrationRepairAttemptClaim, rawOutput: unknown, stopped: boolean): IntegrationRepairAttemptRecord {
      active(); const current = this.read(tx, claim); const output = validateGitAgentRepairRuntimeOutput(rawOutput, current.request);
      if (!current.runtimeRequest) fail('runtime_request_missing');
      if (stopped && !current.processIdentity) fail('process_stop_evidence_missing');
      if (current.output && JSON.stringify(current.output) !== JSON.stringify(output)) fail('attempt_result_conflict');
      if (current.stoppedAtUtcMs !== null) return current;
      currentOwner(current);
      db.prepare('UPDATE integration_repair_attempts SET output=?, stopped_at=? WHERE project_id=? AND attempt_id=?')
        .run(JSON.stringify(output), stopped ? now() : null, claim.projectId, claim.attemptId);
      if (stopped) db.prepare('UPDATE integration_processes SET stopped=1 WHERE project_id=? AND operation_id=? AND launch_id=?')
        .run(claim.projectId,current.operationId,current.processIdentity!.launchId);
      return decode(row(claim)!);
    },
  };
}
