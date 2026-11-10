import { isDeepStrictEqual } from 'node:util';
import type { SqliteStorageSession } from './session.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteIntegrationRepairAuthorizations } from './integration-repair-authorizations.js';
import { createSqliteIntegrationRepairAttempts } from './integration-repair-attempts.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import type { IntegrationRepairAttemptClaim } from '../../ports/integration-repair-attempt.js';
import type { GitAgentRepairHold, GitAgentRepairView } from '../../ports/git-agent-repair-store.js';
import { GIT_AGENT_REPAIR_HOLDS } from '../../ports/git-agent-repair-store.js';
import { StorageError } from '../../ports/errors.js';

/** Finalizer-compatible view of the original queued member, not a second repair Run. */
export function createSqliteIntegrationRepairCandidates(session: SqliteStorageSession,
  options: {claim: IntegrationRepairAttemptClaim; nowUtcMs?: () => number}) {
  const claim = structuredClone(options.claim), now = options.nowUtcMs ?? Date.now;
  const atomic = createSqliteAtomicCommandStore(session,{nowUtcMs:now});
  const authorizations = createSqliteIntegrationRepairAuthorizations(session,{nowUtcMs:now});
  const attempts = createSqliteIntegrationRepairAttempts(session,{nowUtcMs:now});
  function fail(reason: string): never {throw new StorageError('conflict','IntegrationRepairCandidates',reason,{details:{reason}});}
  function read(tx: CommandTransaction, projectId: string, repairId: string): GitAgentRepairView {
    if (projectId !== claim.projectId || repairId !== claim.repairId) fail('candidate_identity_mismatch');
    const authorization = authorizations.read(tx,projectId,repairId), attempt = attempts.read(tx,claim);
    if (!isDeepStrictEqual(attempt.request,authorization.request) || attempt.runId !== authorization.receipt.runId
      || attempt.operationId !== authorization.receipt.operationId || attempt.ownerId !== authorization.fence.ownerId) fail('candidate_identity_mismatch');
    const hold = session.database.prepare('SELECT attempt_id,reason FROM integration_repair_candidate_holds WHERE project_id=? AND repair_id=?')
      .get(projectId,repairId) as {attempt_id:string;reason:GitAgentRepairHold} | undefined;
    if (hold && (hold.attempt_id !== attempt.attemptId || !GIT_AGENT_REPAIR_HOLDS.includes(hold.reason))) fail('candidate_hold_corrupt');
    return {request:authorization.request,receipt:{repairId,parentBatchId:authorization.request.parentBatchId,
      runId:attempt.runId,authorizationDigest:authorization.request.authorizationDigest,blockedReason:null},
      authorizationVersion:attempt.executionVersion,blockedReason:hold?.reason ?? null,
      attempts:[{id:attempt.attemptId,repairId,projectId,runId:attempt.runId,ownerId:attempt.ownerId,
        hostInstanceId:attempt.hostInstanceId,authorizationVersion:attempt.executionVersion,dispatch:attempt.dispatch,
        startedAtUtcMs:attempt.startedAtUtcMs,deadlineUtcMs:attempt.deadlineUtcMs,maxTokens:attempt.maxTokens,
        maxRuntimeMs:attempt.maxRuntimeMs,output:attempt.output,stoppedAtUtcMs:attempt.stoppedAtUtcMs}]};
  }
  return {
    read(projectId:string,repairId:string) {return atomic.transact('IntegrationRepairCandidates.read',tx=>read(tx,projectId,repairId));},
    hold(projectId:string,repairId:string,reason:GitAgentRepairHold) {
      if (!GIT_AGENT_REPAIR_HOLDS.includes(reason)) fail('candidate_hold_invalid');
      return atomic.transact('IntegrationRepairCandidates.hold',tx=>{
        const view = read(tx,projectId,repairId);
        if (view.blockedReason === null) session.database.prepare(`INSERT INTO integration_repair_candidate_holds
          (project_id,repair_id,attempt_id,reason,created_at) VALUES(?,?,?,?,?)`).run(projectId,repairId,claim.attemptId,reason,now());
        return read(tx,projectId,repairId);
      });
    },
  };
}
