import { createHash, randomUUID } from 'node:crypto';
import { mergeEffectiveSettings } from '../../application/effective-settings.js';
import { StorageError } from '../../ports/errors.js';
import { validateAttemptInputSnapshot } from '../../ports/attempt-store.js';
import { ATTEMPT_UPDATED_EVENT_TYPE } from '../../ports/execution-store.js';
import { stableStringify } from '../../ports/feature-plan.js';
import {
  validateRuntimeFallbackAttemptMetadata,
  type RuntimeFallbackSwitchInput,
  type RuntimeFallbackSwitchService,
} from '../../ports/runtime-fallback-switch.js';
import { requirePlainObject, rejectUnknownKeys, validateStableId } from '../../ports/validation.js';
import type { WorkWorkspaceAuthority, WorkResourceStopVerifier } from '../../ports/work-resources.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqliteTaskDagStore } from './task-dag-store.js';
import { createSqliteWorkResourceAccess } from './work-resources.js';
import type { SqliteStorageSession } from './session.js';
import type { TaskClaimReceipt } from '../../ports/task-claim.js';

const operation = 'RuntimeFallbackSwitch.switch';

/**
 * Core-only replacement Attempt transaction. It deliberately does not call the
 * Runtime, inspect the filesystem, or publish artifacts. Those operations happen
 * before/after this short transaction at the application boundary.
 */
export function createSqliteRuntimeFallbackSwitchService(session: SqliteStorageSession, options: {
  readonly workspaceAuthority: WorkWorkspaceAuthority;
  readonly stopVerifier: Pick<WorkResourceStopVerifier, 'inspect'>;
  readonly nowUtcMs?: () => number;
}): RuntimeFallbackSwitchService {
  const db = session.database;
  const dag = createSqliteTaskDagStore(session);
  const clock = options.nowUtcMs ?? Date.now;
  const attempts = createSqliteAttemptAccess(session);
  const resources = createSqliteWorkResourceAccess(session, {
    workspaceAuthority: options.workspaceAuthority,
    stopVerifier: options.stopVerifier,
    nowUtcMs: clock,
  });

  return {
    switch(input) {
      if (!session.isOpen()) throw new StorageError('corrupt', operation, 'Storage session is closed');
      if (db.inTransaction) throw new TypeError('Runtime fallback switch must own its committing transaction');
      const valid = validateInput(input, options.workspaceAuthority);
      if (!valid.authorized) throw conflict('fallback_not_authorized');
      if (valid.decision.mode !== 'switch') throw conflict('all_candidates_unavailable');
      const metadata = validateRuntimeFallbackAttemptMetadata({
        schemaVersion: 1,
        switchKey: valid.switchKey,
        strategySource: valid.decision.strategySource,
        strategy: valid.decision.strategySnapshot,
        triggerCategory: valid.decision.triggerCategory,
        previousFailures: valid.decision.previousFailures,
        policyVersion: valid.policyVersion,
        capabilityEvidence: valid.capabilityEvidence,
      });
      const snapshot = validateAttemptInputSnapshot({ ...valid.inputSnapshot, runtimeFallback: metadata });
      if (snapshot.projectId !== valid.projectId || snapshot.taskId !== valid.taskId) {
        throw new StorageError('validation', operation, 'Fallback input identity mismatch');
      }
      options.stopVerifier.inspect(valid.stopEvidence);
      const requestDigest = createHash('sha256').update(stableStringify({ ...valid, inputSnapshot: snapshot }), 'utf8').digest('hex');

      return session.transactWrite(operation, () => {
        const existing = db.prepare<[string], { project_id: string; request_digest: string; receipt: string }>(
          'SELECT project_id, request_digest, receipt FROM task_claim_receipts WHERE id = ?',
        ).get(valid.switchKey);
        if (existing) {
          if (existing.project_id !== valid.projectId || existing.request_digest !== requestDigest) throw conflict('switch_key_reused');
          const persisted = JSON.parse(existing.receipt) as TaskClaimReceipt;
          const replayAttempt = attempts.getAttempt(valid.projectId, persisted.attempt.id);
          if (replayAttempt.inputSnapshot.runtimeFallback?.switchKey !== valid.switchKey) throw new StorageError('corrupt', operation, 'Fallback receipt identity mismatch');
          return { disposition: 'replayed' as const, paused: false as const, oldAttemptId: valid.oldAttempt.attemptId,
            receipt: { ...persisted, attempt: replayAttempt }, metadata: replayAttempt.inputSnapshot.runtimeFallback! };
        }
        const view = readTaskView(valid.projectId, valid.runId);
        const task = view.plan.tasks.find(item => item.id === valid.taskId);
        const fact = view.facts.find(item => item.taskId === valid.taskId);
        if (!task || !fact || fact.kind !== 'coding') throw conflict('task_outside_scope');
        if (task.featureId !== snapshot.featureId || fact.executionVersion !== valid.oldAttempt.executionVersion
          || view.run.id !== valid.runId || view.batch.id.length === 0) throw conflict('stale_execution_version');
        const old = attempts.getAttempt(valid.projectId, valid.oldAttempt.attemptId);
        if (old.runId !== valid.runId || old.taskId !== valid.taskId
          || old.owner !== valid.oldAttempt.owner || old.hostInstanceId !== valid.oldAttempt.hostInstanceId
          || old.executionVersion !== valid.oldAttempt.executionVersion
          || old.status !== 'failed') throw conflict('old_attempt_not_stopped');

        const prior = [...attempts.listTaskAttempts(valid.projectId, valid.taskId)]
          .find(candidate => candidate.inputSnapshot.runtimeFallback?.switchKey === valid.switchKey);
        if (prior !== undefined) {
          if (prior.runId !== valid.runId || prior.executionVersion !== fact.executionVersion + 1
            || prior.inputSnapshot.runtimeFallback?.switchKey !== valid.switchKey) throw conflict('switch_key_reused');
          const persisted = JSON.parse((db.prepare('SELECT receipt FROM task_claim_receipts WHERE id = ?').get(valid.switchKey) as { receipt: string }).receipt) as TaskClaimReceipt;
          return { disposition: 'replayed' as const, paused: false as const, oldAttemptId: old.id,
            receipt: { ...persisted, attempt: attempts.getAttempt(valid.projectId, prior.id) }, metadata: prior.inputSnapshot.runtimeFallback! };
        }
        if (task.revision >= Number.MAX_SAFE_INTEGER - 2 || fact.attemptCounter >= Number.MAX_SAFE_INTEGER - 2) {
          throw conflict('counter_overflow');
        }
        const now = clock();
        if (!Number.isSafeInteger(now) || now < 1 || valid.leaseUntilUtcMs <= now) throw new StorageError('validation', operation, 'Invalid fallback lease');
        const oldIdentity = { projectId: valid.projectId, attemptId: old.id, owner: old.owner,
          hostInstanceId: old.hostInstanceId, executionVersion: old.executionVersion };
        // The verifier compares the exact durable old snapshot before any new lease is acquired.
        // A lifecycle settlement may already have released the same verified snapshot; in that
        // case there is nothing left to release, while a partial group remains a hard conflict.
        const oldResources = resources.read(oldIdentity);
        if (oldResources.leases.length === 3) resources.releaseStoppedInTransaction(oldIdentity, valid.stopEvidence);
        else if (oldResources.leases.length !== 0) throw conflict('workspace_occupied');
        const nextAttemptId = randomUUID();
        const nextExecutionVersion = fact.executionVersion + 1;
        const nextNumber = fact.attemptCounter + 1;
        const changed = db.prepare("UPDATE tasks SET status = 'running', execution_version = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ? AND execution_version = ? AND status IN ('failed', 'pending') AND manual_block = 0")
          .run(nextExecutionVersion, now, task.id, valid.projectId, task.revision, fact.executionVersion);
        if (changed.changes !== 1) throw conflict('stale_task');
        const nextSnapshot = { ...snapshot, taskRevision: task.revision + 1 };
        db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
          number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(nextAttemptId, now, now, valid.projectId, task.featureId, valid.runId, task.id, nextNumber,
            valid.newOwner, valid.newHostInstanceId, nextExecutionVersion, valid.leaseUntilUtcMs,
            JSON.stringify(nextSnapshot), nextSnapshot.digests.snapshotDigest, nextSnapshot.group.snapshot.artifactId);
        const execution = createSqliteExecutionAccess(session, { nowUtcMs: () => now });
        const maxAttemptsPerTask = mergeEffectiveSettings({ global: view.settings.global, project: view.settings.project })
          .policies.executionLimits?.value.maxAttemptsPerTask ?? null;
        const reservation = execution.reserveTaskAttemptInTransaction({ projectId: valid.projectId, batchId: view.batch.id,
          runId: valid.runId, taskId: task.id, attemptKey: nextAttemptId, maxAttemptsPerTask });
        execution.reserveRuntimeStartInTransaction({ projectId: valid.projectId, batchId: view.batch.id,
          runId: valid.runId, startKey: nextAttemptId });
        const occupied = resources.acquireInTransaction({ projectId: valid.projectId, attemptId: nextAttemptId,
          owner: valid.newOwner, hostInstanceId: valid.newHostInstanceId, executionVersion: nextExecutionVersion },
          valid.workspace, valid.leaseUntilUtcMs);
        const counters = execution.getTaskExecutionCountersInTransaction(valid.projectId, task.id);
        const eventId = execution.appendExecutionEventInTransaction({ projectId: valid.projectId,
          eventType: ATTEMPT_UPDATED_EVENT_TYPE, aggregateType: 'task', aggregateId: task.id,
          aggregateRevision: counters.revision, payload: { updated: true } });
        const attempt = attempts.getAttempt(valid.projectId, nextAttemptId);
        const receipt: TaskClaimReceipt = { schemaVersion: 1, claimKey: valid.switchKey, batchId: view.batch.id,
          attempt, taskRevision: counters.revision, reservationId: reservation.id, leases: occupied.leases,
          counts: { batchAttempts: view.batch.attemptsCreated + 1, runAttempts: view.run.attemptsCreated + 1,
            taskAttempts: counters.attemptCounter, codeAttempts: counters.codeAttemptsUsed }, eventId };
        db.prepare('INSERT INTO task_claim_receipts (id, project_id, attempt_id, request_digest, receipt) VALUES (?, ?, ?, ?, ?)')
          .run(valid.switchKey, valid.projectId, nextAttemptId, requestDigest, JSON.stringify(receipt));
        return { disposition: 'applied' as const, paused: false as const, oldAttemptId: old.id, receipt, metadata };
      });
    },
    stop(input: unknown) {
      if (!session.isOpen()) throw new StorageError('corrupt', operation, 'Storage session is closed');
      if (db.inTransaction) throw new TypeError('Runtime fallback stop must own its committing transaction');
      const raw = requirePlainObject(input, { operation }, 'input');
      rejectUnknownKeys(raw, ['pause', 'reason'], { operation }, 'input');
      const pause = requirePlainObject(raw.pause, { operation }, 'pause');
      rejectUnknownKeys(pause, ['projectId', 'targetKind', 'targetId', 'expectedRevision'], { operation }, 'pause');
      const projectId = validateStableId(pause.projectId, { operation }, 'pause.projectId');
      const targetId = validateStableId(pause.targetId, { operation }, 'pause.targetId');
      if (pause.targetKind !== 'run' && pause.targetKind !== 'batch') throw new StorageError('validation', operation, 'Invalid pause target');
      if (!Number.isSafeInteger(pause.expectedRevision) || Number(pause.expectedRevision) < 1) throw new StorageError('validation', operation, 'Invalid pause revision');
      session.transactWrite(operation, () => createSqliteExecutionAccess(session, { nowUtcMs: clock }).requestExecutionPauseInTransaction({
        projectId, targetKind: pause.targetKind as 'run' | 'batch', targetId, expectedRevision: pause.expectedRevision as number,
      }));
      return { disposition: 'stopped' as const, paused: true as const,
        reason: (raw.reason === 'recovery_unsafe' || raw.reason === 'workspace_occupied' || raw.reason === 'stop_unconfirmed' || raw.reason === 'fallback_not_authorized'
          ? raw.reason : 'all_candidates_unavailable') as 'all_candidates_unavailable' | 'fallback_not_authorized' | 'stop_unconfirmed' | 'workspace_occupied' | 'recovery_unsafe' };
    },
  };

  function readTaskView(projectId: string, runId: string) {
    return dag.readTaskDagView(projectId, runId);
  }
}

function validateInput(value: unknown, authority: WorkWorkspaceAuthority): RuntimeFallbackSwitchInput {
  const context = { operation };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['switchKey', 'projectId', 'runId', 'taskId', 'oldAttempt', 'newOwner', 'newHostInstanceId',
    'workspace', 'leaseUntilUtcMs', 'stopEvidence', 'authorized', 'decision', 'policyVersion', 'capabilityEvidence', 'inputSnapshot'], context, 'input');
  const id = (key: string) => validateStableId(raw[key], context, key);
  const oldRaw = requirePlainObject(raw.oldAttempt, context, 'oldAttempt');
  rejectUnknownKeys(oldRaw, ['attemptId', 'owner', 'hostInstanceId', 'executionVersion'], context, 'oldAttempt');
  const number = (key: string) => {
    const value = raw[key];
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new StorageError('validation', operation, `Invalid ${key}`);
    return value as number;
  };
  const oldVersion = oldRaw.executionVersion;
  if (!Number.isSafeInteger(oldVersion) || Number(oldVersion) < 0) throw new StorageError('validation', operation, 'Invalid old executionVersion');
  const decision = requirePlainObject(raw.decision, context, 'decision');
  rejectUnknownKeys(decision, ['mode', 'triggerCategory', 'previousFailures', 'strategySource', 'strategySnapshot'], context, 'decision');
  const snapshot = requirePlainObject(raw.inputSnapshot, context, 'inputSnapshot');
  return {
    switchKey: id('switchKey'), projectId: id('projectId'), runId: id('runId'), taskId: id('taskId'),
    oldAttempt: { attemptId: validateStableId(oldRaw.attemptId, context, 'oldAttempt.attemptId'),
      owner: validateStableId(oldRaw.owner, context, 'oldAttempt.owner'),
      hostInstanceId: validateStableId(oldRaw.hostInstanceId, context, 'oldAttempt.hostInstanceId'), executionVersion: oldVersion as number },
    newOwner: id('newOwner'), newHostInstanceId: id('newHostInstanceId'),
    workspace: authority.inspect(raw.workspace), leaseUntilUtcMs: number('leaseUntilUtcMs'), stopEvidence: raw.stopEvidence,
    authorized: raw.authorized === true, decision: decision as RuntimeFallbackSwitchInput['decision'],
    policyVersion: raw.policyVersion as string, capabilityEvidence: raw.capabilityEvidence as RuntimeFallbackSwitchInput['capabilityEvidence'],
    inputSnapshot: snapshot as unknown as RuntimeFallbackSwitchInput['inputSnapshot'],
  };
}

function conflict(reason: string): StorageError {
  return new StorageError('conflict', operation, `Runtime fallback rejected: ${reason}`, { details: { reason } });
}
