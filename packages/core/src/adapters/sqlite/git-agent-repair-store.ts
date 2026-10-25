import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import { validateAttemptUsageSummary } from '../../ports/attempt-store.js';
import { validateIntegrationObservation } from '../../ports/git-integration-observation.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { StorageError } from '../../ports/errors.js';
import { validateTaskClaimDispatch } from '../../ports/task-claim.js';
import { validateStableId, validatePositiveInteger } from '../../ports/validation.js';
import { validateGitAgentRepairRequest, validateGitAgentRepairRuntimeOutput } from '../../ports/git-agent-repair.js';
import type { GitAgentRepairRequest } from '../../ports/git-agent-repair.js';
import { GIT_AGENT_REPAIR_HOLDS, GIT_AGENT_REPAIR_RUN_PURPOSE } from '../../ports/git-agent-repair-store.js';
import type { GitAgentRepairAttempt, GitAgentRepairClaim, GitAgentRepairHold, GitAgentRepairReceipt,
  GitAgentRepairStore, GitAgentRepairView } from '../../ports/git-agent-repair-store.js';
import { enqueueAuthorizedRunInTransaction } from '../../application/execution-dispatch.js';
import { createSqliteAttemptDispatchAccess } from './attempt-dispatch.js';
import type { SqliteStorageSession } from './session.js';

const OP = 'GitAgentRepair';
const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
interface RepairRow {
  repair_id: string; project_id: string; batch_id: string; feature_id: string; source_operation_id: string;
  run_id: string | null; request: string; authorization_digest: string; authorization_version: number;
  receipt: string; blocked_reason: GitAgentRepairHold | null;
}
interface AttemptRow {
  id: string; project_id: string; repair_id: string; run_id: string; owner_id: string; host_instance_id: string;
  authorization_version: number; dispatch: string; started_at: number; deadline_at: number;
  max_tokens: number; max_runtime_ms: number; output: string | null; stopped_at: number | null;
}
function fail(reason: string, kind: 'conflict' | 'validation' | 'ownership' | 'not_found' | 'corrupt' = 'conflict'): never {
  throw new StorageError(kind, OP, reason, { details: { reason } });
}

/** Core-private authorizations/attempt evidence, not a second dispatch queue or Git state machine.
 * Existing Run/Batch counters, dispatch claims, slots and Feature resource leases remain authoritative.
 */
export function createSqliteGitAgentRepairStore(session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {}): GitAgentRepairStore {
  const db = session.database;
  const now = options.nowUtcMs ?? Date.now;
  const dispatch = createSqliteAttemptDispatchAccess(session, { nowUtcMs: now });
  function active() {
    if (!session.isOpen() || !db.inTransaction) throw new TypeError('GitAgentRepair requires CommandTransaction');
  }
  function row(projectId: string, repairId: string): RepairRow {
    active();
    validateStableId(projectId, { operation: OP }, 'projectId');
    validateStableId(repairId, { operation: OP }, 'repairId');
    const value = db.prepare('SELECT * FROM git_agent_repairs WHERE repair_id = ?').get(repairId) as RepairRow | undefined;
    if (!value) fail('repair_not_found', 'not_found');
    if (value.project_id !== projectId) fail('cross_project', 'ownership');
    return value;
  }
  function view(tx: CommandTransaction, projectId: string, repairId: string): GitAgentRepairView {
    const value = row(projectId, repairId);
    try {
      const request = validateGitAgentRepairRequest(JSON.parse(value.request), { nowUtcMs: 0 });
      const receipt = JSON.parse(value.receipt) as GitAgentRepairReceipt;
      if (request.projectId !== projectId || request.repairId !== repairId || request.parentBatchId !== value.batch_id
        || request.featureId !== value.feature_id || request.source.operationId !== value.source_operation_id
        || request.authorizationDigest !== value.authorization_digest || receipt.runId !== value.run_id
        || receipt.authorizationDigest !== request.authorizationDigest || receipt.repairId !== repairId
        || receipt.parentBatchId !== value.batch_id) fail('repair_identity_corrupt', 'corrupt');
      if (value.run_id !== null) {
        const run = tx.getExecutionRun(projectId, value.run_id);
        if (run.purpose !== GIT_AGENT_REPAIR_RUN_PURPOSE || run.batchId !== value.batch_id
          || run.featureId !== value.feature_id || run.scopeDigest !== request.authorizationDigest) fail('repair_run_corrupt', 'corrupt');
      }
      const attempts = (db.prepare('SELECT * FROM git_agent_repair_attempts WHERE repair_id = ? ORDER BY started_at, rowid')
        .all(repairId) as AttemptRow[]).map(a => {
        if (a.project_id !== projectId || a.run_id !== value.run_id || a.authorization_version !== value.authorization_version) fail('repair_attempt_corrupt', 'corrupt');
        return {
          id: a.id, projectId: a.project_id, repairId: a.repair_id, runId: a.run_id,
          ownerId: a.owner_id, hostInstanceId: a.host_instance_id, authorizationVersion: a.authorization_version,
          dispatch: validateTaskClaimDispatch(JSON.parse(a.dispatch)), startedAtUtcMs: a.started_at, deadlineUtcMs: a.deadline_at,
          maxTokens: a.max_tokens, maxRuntimeMs: a.max_runtime_ms,
          output: a.output === null ? null : validateGitAgentRepairRuntimeOutput(JSON.parse(a.output), request),
          stoppedAtUtcMs: a.stopped_at,
        } satisfies GitAgentRepairAttempt;
      });
      return { receipt, request, authorizationVersion: value.authorization_version, blockedReason: value.blocked_reason, attempts };
    } catch (error) {
      if (error instanceof StorageError && error.kind === 'corrupt') throw error;
      throw new StorageError('corrupt', OP, 'Invalid persisted repair evidence', { cause: error });
    }
  }
  function hold(tx: CommandTransaction, projectId: string, repairId: string, reason: GitAgentRepairHold) {
    if (!GIT_AGENT_REPAIR_HOLDS.includes(reason)) fail('invalid_hold', 'validation');
    const current = row(projectId, repairId);
    if (current.blocked_reason === null) db.prepare('UPDATE git_agent_repairs SET blocked_reason = ? WHERE repair_id = ?')
      .run(reason, repairId);
    // No mutation of Task, integration result, resource lease, slot or successor readiness.
    const held = current.blocked_reason ?? reason;
    // Keep the first human hold; subsequent model/script outcomes cannot replace it.
    if (current.run_id !== null) db.prepare(`UPDATE runs SET reason = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND reason IS NOT ?`).run(held, now(), current.run_id, held);
    return view(tx, projectId, repairId);
  }
  function source(tx: CommandTransaction, request: GitAgentRepairRequest) {
    const batch = tx.getExecutionBatch(request.projectId, request.parentBatchId);
    const run = tx.getExecutionRun(request.projectId, request.runId);
    const operation = tx.getGitOperation(request.projectId, request.source.operationId);
    const binding = tx.getRepositoryBinding(request.projectId);
    if (binding.id !== operation.intent.repositoryBindingId || binding.repoIdentity !== operation.intent.repoIdentity) fail('repository_binding_changed');
    const plan = operation.intent.integrationPlan;
    if (batch.phaseId !== request.phaseId || run.batchId !== batch.id || run.featureId !== request.featureId
      || !tx.listExecutionBatchMemberFeatureIds(request.projectId, batch.id).includes(request.featureId)
      || operation.intent.featureId !== request.featureId || operation.intent.runId !== run.id
      || operation.intentDigest !== request.source.operationDigest || operation.intent.operationType !== request.source.operationType
      || plan == null || plan.integrationId !== request.source.integrationId || plan.inputDigest !== request.source.inputDigest
      || plan.batchId !== batch.id || plan.phaseId !== batch.phaseId
      || operation.intent.repoIdentity !== request.target.repoIdentity || operation.intent.expectedHead !== request.target.baselineCommitSha) {
      fail('failure_source_identity_mismatch');
    }
    // Only a persisted Core failure receipt or journal observation authorizes repair.
    const reasons = request.source.failureKind === 'conflict' ? ['merge_conflict', 'integration_conflict']
      : ['combined_verification_failed', 'combined_check_failed', 'verification_failed'];
    const observationRow = db.prepare(`SELECT id, observation FROM git_integration_observations
      WHERE project_id = ? AND operation_id = ? ORDER BY sequence DESC LIMIT 1`)
      .get(request.projectId, request.source.operationId) as { id: string; observation: string } | undefined;
    const observation = observationRow === undefined ? null
      : validateIntegrationObservation(JSON.parse(observationRow.observation), operation.intent);
    const failedReceipt = operation.status === 'failed' && operation.workspacePreserved && reasons.includes(operation.reasonCode ?? '');
    const conflictObservation = request.source.failureKind === 'conflict' && operation.status === 'pending'
      && observation?.outcome === 'blocked' && observation.workspace !== null && reasons.includes(observation.reason ?? '');
    if (!failedReceipt && !conflictObservation) fail('failure_not_authorized');
    const evidence = failedReceipt ? operation.receipt : observation;
    const evidenceId = failedReceipt ? request.source.operationId : observationRow!.id;
    if (request.source.evidenceId !== evidenceId || request.source.evidenceDigest !== hash(evidence)) fail('failure_evidence_mismatch');
    if (request.workspace.workspaceId !== plan.integrationId || request.workspace.workspaceDigest !== hash({
      repoIdentity: operation.intent.repoIdentity, worktreePath: operation.intent.worktreePath,
      inputDigest: plan.inputDigest, baselineCommitSha: operation.intent.expectedHead,
    })) fail('workspace_identity_mismatch');
    return { batch, run };
  }
  function parentTokensRemaining(tx: CommandTransaction, request: GitAgentRepairRequest): number | null {
    const batch = tx.getExecutionBatch(request.projectId, request.parentBatchId);
    const limit = batch.budgetSnapshot.batch.maxTokenTotal;
    if (limit === undefined) return Number.MAX_SAFE_INTEGER;
    let used = 0;
    const coding = db.prepare(`SELECT a.usage_summary FROM attempts a JOIN runs r ON r.id = a.run_id
      WHERE a.project_id = ? AND r.batch_id = ?`).all(request.projectId, batch.id) as { usage_summary: string | null }[];
    for (const item of coding) {
      const usage = validateAttemptUsageSummary(item.usage_summary === null ? null : JSON.parse(item.usage_summary));
      if (usage?.inputTokens == null || usage.outputTokens === null) return null;
      used += usage.inputTokens + usage.outputTokens;
    }
    const repairs = db.prepare(`SELECT a.output, a.max_tokens, a.stopped_at FROM git_agent_repair_attempts a
      JOIN git_agent_repairs r ON r.repair_id = a.repair_id WHERE r.project_id = ? AND r.batch_id = ?`)
      .all(request.projectId, batch.id) as { output: string | null; max_tokens: number; stopped_at: number | null }[];
    for (const item of repairs) {
      // Outstanding admissions reserve their full grant. Final usage is counted once;
      // output cannot be used to refund a possibly live writer's reservation.
      if (item.stopped_at === null || item.output === null) used += item.max_tokens;
      else {
        const output = JSON.parse(item.output) as { usage?: { consumedTokens?: unknown } };
        const tokens = output.usage?.consumedTokens;
        if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) fail('repair_usage_corrupt', 'corrupt');
        used += tokens;
      }
    }
    return Number.isSafeInteger(used) ? Math.max(0, limit - used) : 0;
  }
  function parentAllows(tx: CommandTransaction, request: GitAgentRepairRequest, creatingRun: boolean, checkControl = true): boolean {
    const batch = tx.getExecutionBatch(request.projectId, request.parentBatchId);
    const limit = batch.budgetSnapshot.batch;
    const tokens = parentTokensRemaining(tx, request);
    // Cost remains unconfirmed: repair output has no trusted cost measurement.
    return (!checkControl || (['queued', 'running'].includes(batch.status) && batch.pauseRequestedAtUtcMs === null))
      && now() < Math.min(batch.deadlineAtUtcMs, request.budget.deadlineUtcMs)
      && (!creatingRun || batch.runsCreated < limit.maxRuns)
      && batch.attemptsCreated < limit.maxTotalAttempts && batch.runtimeStarts < limit.maxRuntimeStarts
      && batch.noProgressRuns < limit.maxNoProgressRuns
      && tokens !== null && tokens > 0 && limit.maxCostTotal === undefined;
  }
  function claimIdentity(input: GitAgentRepairClaim) {
    for (const key of ['projectId', 'repairId', 'attemptId', 'ownerId', 'hostInstanceId'] as const) {
      validateStableId(input[key], { operation: OP }, key);
    }
    if (input.claimKey !== undefined) validateStableId(input.claimKey, { operation: OP }, 'claimKey');
    validatePositiveInteger(input.authorizationVersion, { operation: OP }, 'authorizationVersion');
  }
  function fence(attempt: GitAgentRepairAttempt, input: GitAgentRepairClaim) {
    if (attempt.ownerId !== input.ownerId || attempt.hostInstanceId !== input.hostInstanceId
      || attempt.authorizationVersion !== input.authorizationVersion) fail('stale_repair_owner');
    const current = db.prepare(`SELECT c.id FROM run_dispatch_claims c JOIN execution_slot_claims s ON s.claim_id = c.id
      WHERE c.project_id = ? AND c.run_id = ? AND c.id = ? AND c.claim_version = ?
      AND c.owner_id = ? AND c.host_instance_id = ? AND c.state = 'held' AND s.state = 'held'
      AND s.id = ? AND s.claim_version = c.claim_version AND s.owner_id = c.owner_id
      AND s.host_instance_id = c.host_instance_id`).get(input.projectId, attempt.runId, attempt.dispatch.claimId,
        attempt.dispatch.claimVersion, input.ownerId, input.hostInstanceId, attempt.dispatch.slotId);
    if (!current) fail('stale_dispatch_identity');
  }
  return {
    read: view,
    hold,
    authorize(tx, raw, requestedHold) {
      active();
      const request = validateGitAgentRepairRequest(raw, { nowUtcMs: 0 });
      if (requestedHold !== undefined && !GIT_AGENT_REPAIR_HOLDS.includes(requestedHold)) fail('invalid_hold', 'validation');
      const command = db.prepare('SELECT repair_id, command_digest FROM git_agent_repair_commands WHERE project_id = ? AND command_id = ?')
        .get(request.projectId, request.commandId) as { repair_id: string; command_digest: string } | undefined;
      if (command) {
        if (command.repair_id !== request.repairId || command.command_digest !== request.commandDigest) fail('command_digest_conflict');
        return view(tx, request.projectId, command.repair_id).receipt;
      }
      const existing = db.prepare('SELECT * FROM git_agent_repairs WHERE repair_id = ? OR (project_id = ? AND source_operation_id = ?)')
        .all(request.repairId, request.projectId, request.source.operationId) as RepairRow[];
      if (existing.length > 0) {
        if (existing.length !== 1 || existing[0]!.project_id !== request.projectId || existing[0]!.repair_id !== request.repairId
          || existing[0]!.authorization_digest !== request.authorizationDigest) fail('repair_identity_conflict');
        db.prepare('INSERT INTO git_agent_repair_commands VALUES (?, ?, ?, ?)')
          .run(request.projectId, request.commandId, request.repairId, request.commandDigest);
        return view(tx, request.projectId, request.repairId).receipt;
      }
      const { batch, run: sourceRun } = source(tx, request);
      let blockedReason = requestedHold ?? null;
      if (!parentAllows(tx, request, true)) blockedReason ??= 'budget_exhausted';
      // Never steal a still-active source Run or an unconfirmed writer's resources.
      if (tx.getActiveExecutionRun(request.projectId, request.featureId) !== null
        || !['failed', 'cancelled', 'succeeded'].includes(sourceRun.status)
        || db.prepare(`SELECT id FROM attempts WHERE project_id = ? AND run_id = ?
          AND status IN ('preparing','executing','verifying','interrupted') LIMIT 1`).get(request.projectId, sourceRun.id)
        || db.prepare(`SELECT c.id FROM run_dispatch_claims c WHERE c.project_id = ? AND c.run_id = ? AND c.state <> 'released'`)
          .get(request.projectId, sourceRun.id)) blockedReason ??= 'identity_or_lock';
      const runId = blockedReason === null ? randomUUID() : null;
      if (runId !== null) {
        tx.recordExecutionRunDispatch(request.projectId, batch.id);
        tx.insertExecutionRun({
          projectId: request.projectId, batchId: batch.id, featureId: request.featureId, runId,
          purpose: GIT_AGENT_REPAIR_RUN_PURPOSE, inputSnapshot: { repairId: request.repairId, authorizationDigest: request.authorizationDigest },
          configSnapshot: { ...sourceRun.configSnapshot, childAgents: false, authorizationVersion: batch.budgetRevision },
          status: 'queued', scopeDigest: request.authorizationDigest, workKey: hash({ repairId: request.repairId }), dispatchOrdinal: 1,
          maxAttemptsPerRun: Math.min(request.budget.remainingAttempts, batch.budgetSnapshot.run.maxAttemptsPerRun),
          runTimeLimitMs: Math.min(request.budget.remainingRuntimeMs, batch.budgetSnapshot.run.runTimeLimitMs), reason: null,
        });
        enqueueAuthorizedRunInTransaction(tx, { projectId: request.projectId, runId, source: 'start' });
        tx.appendExecutionEvent({ projectId: request.projectId, eventType: 'execution.run.dispatched',
          aggregateType: 'run', aggregateId: runId, aggregateRevision: 1, payload: { dispatched: true } });
      }
      const receipt: GitAgentRepairReceipt = { repairId: request.repairId, parentBatchId: batch.id,
        runId, authorizationDigest: request.authorizationDigest, blockedReason };
      db.prepare(`INSERT INTO git_agent_repairs (repair_id, project_id, batch_id, feature_id, source_operation_id,
        run_id, request, authorization_digest, authorization_version, receipt, blocked_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(request.repairId, request.projectId, batch.id, request.featureId,
          request.source.operationId, runId, JSON.stringify(request), request.authorizationDigest, batch.budgetRevision,
          JSON.stringify(receipt), blockedReason, now());
      db.prepare('INSERT INTO git_agent_repair_commands VALUES (?, ?, ?, ?)')
        .run(request.projectId, request.commandId, request.repairId, request.commandDigest);
      return receipt;
    },
    claim(tx, input) {
      active();
      claimIdentity(input);
      const current = view(tx, input.projectId, input.repairId);
      const previous = current.attempts.find(a => a.id === input.attemptId);
      const keyed = input.claimKey === undefined ? undefined : current.attempts.find(a => a.dispatch.claimKey === input.claimKey);
      if (keyed !== undefined && keyed.id !== input.attemptId) fail('attempt_identity_conflict');
      if (previous) {
        if (previous.ownerId !== input.ownerId || previous.hostInstanceId !== input.hostInstanceId
          || previous.authorizationVersion !== input.authorizationVersion) fail('attempt_identity_conflict');
        // A repeated admission is evidence only; the consumer must not start it again.
        return null;
      }
      if (db.prepare('SELECT id FROM git_agent_repair_attempts WHERE id = ?').get(input.attemptId)) fail('attempt_identity_conflict');
      if (current.blockedReason !== null || current.receipt.runId === null) return null;
      if (current.authorizationVersion !== input.authorizationVersion) fail('authorization_version_stale');
      const run = tx.getExecutionRun(input.projectId, current.receipt.runId);
      const batch = tx.getExecutionBatch(input.projectId, current.request.parentBatchId);
      if (!['queued', 'running'].includes(run.status) || !['queued', 'running'].includes(batch.status)
        || run.pauseRequestedAtUtcMs !== null || batch.pauseRequestedAtUtcMs !== null) return null;
      if (batch.budgetRevision !== current.authorizationVersion) {
        hold(tx, input.projectId, input.repairId, 'identity_or_lock');
        return null;
      }
      if (current.attempts.some(a => a.stoppedAtUtcMs === null)) return null;
      const tokensUsed = current.attempts.reduce((n, a) => n + (a.output?.usage.consumedTokens ?? a.maxTokens), 0);
      const runtimeUsed = current.attempts.reduce((n, a) => n + Math.max(a.output?.usage.runtimeMs ?? a.maxRuntimeMs,
        (a.stoppedAtUtcMs ?? now()) - a.startedAtUtcMs), 0);
      const maxTokens = Math.min(current.request.budget.remainingTokens - tokensUsed, parentTokensRemaining(tx, current.request) ?? 0);
      const maxRuntimeMs = Math.min(current.request.budget.remainingRuntimeMs - runtimeUsed,
        run.runTimeLimitMs - runtimeUsed,
        run.startedAtUtcMs === null ? run.runTimeLimitMs : run.startedAtUtcMs + run.runTimeLimitMs - now(),
        current.request.budget.deadlineUtcMs - now(), batch.deadlineAtUtcMs - now());
      if (!parentAllows(tx, current.request, false) || current.attempts.length >= current.request.budget.remainingAttempts
        || run.attemptsCreated >= run.maxAttemptsPerRun || maxTokens <= 0 || maxRuntimeMs <= 0) {
        hold(tx, input.projectId, input.repairId, 'budget_exhausted');
        return null;
      }
      // A savepoint preserves the outer authorization/hold transaction while rolling back
      // ALL partial claim/slot/resource/budget mutations on failed admission.
      db.exec('SAVEPOINT git_agent_admission');
      try {
        source(tx, current.request);
        const deadlineUtcMs = now() + maxRuntimeMs;
        const admittedBase = dispatch.acquireInTransaction({ id: input.attemptId, projectId: input.projectId,
          featureId: current.request.featureId, runId: run.id, owner: input.ownerId, hostInstanceId: input.hostInstanceId,
          leaseUntilUtcMs: deadlineUtcMs, inputSnapshot: current.request, integrationWorkspaceId: current.request.workspace.workspaceId });
        const admitted = input.claimKey === undefined ? admittedBase : { ...admittedBase, claimKey: input.claimKey };
        tx.reserveRuntimeStart({ projectId: input.projectId, batchId: batch.id, runId: run.id, startKey: input.attemptId });
        db.prepare('UPDATE execution_batches SET attempts_created = attempts_created + 1, revision = revision + 1, updated_at = ? WHERE id = ?')
          .run(now(), batch.id);
        db.prepare(`UPDATE runs SET attempts_created = attempts_created + 1, status = 'running',
          started_at = COALESCE(started_at, ?), revision = revision + 1, updated_at = ? WHERE id = ?`).run(now(), now(), run.id);
        db.prepare(`INSERT INTO git_agent_repair_attempts (id, project_id, repair_id, run_id, owner_id, host_instance_id,
          authorization_version, dispatch, started_at, deadline_at, max_tokens, max_runtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.attemptId, input.projectId, input.repairId, run.id, input.ownerId, input.hostInstanceId,
            input.authorizationVersion, JSON.stringify(admitted), now(), deadlineUtcMs, maxTokens, maxRuntimeMs);
        db.exec('RELEASE git_agent_admission');
      } catch (error) {
        db.exec('ROLLBACK TO git_agent_admission');
        db.exec('RELEASE git_agent_admission');
        if (!(error instanceof StorageError) || !['conflict', 'ownership'].includes(error.kind)) throw error;
        hold(tx, input.projectId, input.repairId, error.details?.reason === 'budget_exhausted' ? 'budget_exhausted' : 'identity_or_lock');
        return null;
      }
      return view(tx, input.projectId, input.repairId).attempts.find(a => a.id === input.attemptId)!;
    },
    settle(tx, input, rawOutput, stopped) {
      active();
      claimIdentity(input);
      const current = view(tx, input.projectId, input.repairId);
      const attempt = current.attempts.find(a => a.id === input.attemptId);
      if (!attempt) fail('attempt_not_found', 'not_found');
      fence(attempt, input);
      if (attempt.stoppedAtUtcMs !== null) {
        const output = validateGitAgentRepairRuntimeOutput(rawOutput, current.request);
        if (!isDeepStrictEqual(attempt.output, output)) fail('attempt_result_conflict');
        return current;
      }
      let output;
      try { output = validateGitAgentRepairRuntimeOutput(rawOutput, current.request); }
      catch (error) {
        return hold(tx, input.projectId, input.repairId,
          error instanceof StorageError && error.details?.reason === 'budget_exhausted' ? 'budget_exhausted' : 'invalid_runtime_output');
      }
      if (attempt.output !== null && !isDeepStrictEqual(attempt.output, output)) fail('attempt_result_conflict');
      db.prepare('UPDATE git_agent_repair_attempts SET output = ?, stopped_at = ? WHERE id = ?')
        .run(JSON.stringify(output), stopped ? now() : null, attempt.id);
      if (!stopped) return hold(tx, input.projectId, input.repairId, 'stop_unconfirmed');
      const run = tx.getExecutionRun(input.projectId, attempt.runId);
      const batch = tx.getExecutionBatch(input.projectId, current.request.parentBatchId);
      const tokensUsed = current.attempts.reduce((n, a) => n + (a.id === attempt.id ? output.usage.consumedTokens : (a.output?.usage.consumedTokens ?? a.maxTokens)), 0);
      const runtimeUsed = current.attempts.reduce((n, a) => n + (a.id === attempt.id ? Math.max(output.usage.runtimeMs, now() - a.startedAtUtcMs)
        : Math.max(a.output?.usage.runtimeMs ?? a.maxRuntimeMs, (a.stoppedAtUtcMs ?? now()) - a.startedAtUtcMs)), 0);
      if (tokensUsed >= current.request.budget.remainingTokens || output.usage.consumedTokens > attempt.maxTokens
        || runtimeUsed >= Math.min(current.request.budget.remainingRuntimeMs, run.runTimeLimitMs)
        || (run.startedAtUtcMs !== null && now() >= run.startedAtUtcMs + run.runTimeLimitMs)
        || current.attempts.length >= Math.min(current.request.budget.remainingAttempts, run.maxAttemptsPerRun)
        || !parentAllows(tx, current.request, false, false)
        || now() >= Math.min(attempt.deadlineUtcMs, batch.deadlineAtUtcMs)) hold(tx, input.projectId, input.repairId, 'budget_exhausted');
      const risk = output.failureCode as GitAgentRepairHold | null;
      if (risk !== null && GIT_AGENT_REPAIR_HOLDS.includes(risk)) hold(tx, input.projectId, input.repairId, risk);
      // Only lifecycle bookkeeping: no integration evidence or successor readiness is changed.
      if (run.status === 'pausing') db.prepare("UPDATE runs SET status = 'paused', revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(now(), run.id);
      else if (run.status === 'running' && output.status === 'modified') db.prepare("UPDATE runs SET status = 'paused', reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(row(input.projectId, input.repairId).blocked_reason ?? 'repair_pending_verification', now(), run.id);
      if (batch.status === 'pausing') {
        const coding = db.prepare(`SELECT a.id FROM attempts a JOIN runs r ON r.id = a.run_id
          WHERE r.batch_id = ? AND a.status IN ('preparing','executing','verifying') LIMIT 1`).get(batch.id);
        const repairing = db.prepare(`SELECT a.id FROM git_agent_repair_attempts a JOIN runs r ON r.id = a.run_id
          WHERE r.batch_id = ? AND a.stopped_at IS NULL LIMIT 1`).get(batch.id);
        if (!coding && !repairing) db.prepare("UPDATE execution_batches SET status = 'paused', revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(now(), batch.id);
      }
      return view(tx, input.projectId, input.repairId);
    },
  };
}
