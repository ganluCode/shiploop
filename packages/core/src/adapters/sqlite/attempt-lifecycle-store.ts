import { createHash, randomUUID } from 'node:crypto';
import { evaluateTaskDag } from '../../application/task-dag.js';
import { verifyFeaturePlanApprovalInTransaction } from '../../application/plan-approval-verification.js';
import { createSqliteWorkSessionStore } from './work-session-store.js';
import { ACTIVE_ATTEMPT_STATUSES } from '../../ports/attempt-store.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId } from '../../ports/validation.js';
import {
  ATTEMPT_UPDATED_EVENT_TYPE, validateAttemptNotification,
  type AttemptApplicationResult, type AttemptLifecycleStore,
} from '../../ports/attempt-lifecycle.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import type { WorkResourceIdentity, WorkResourceStopVerifier, WorkWorkspaceAuthority } from '../../ports/work-resources.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteTaskDagStore } from './task-dag-store.js';
import { createSqliteWorkResourceAccess } from './work-resources.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';
import type { SqliteStorageSession } from './session.js';

export interface SqliteAttemptLifecycleStore extends AttemptLifecycleStore {
  /** Trusted composition only: joins workspace/result CAS without opening a nested transaction. */
  recordWorkspaceRetentionInTransaction(transaction: CommandTransaction, identity: WorkResourceIdentity,
    expectedRevision: number, evidenceRef: string): void;
  applyPreparationFailureInTransaction(transaction: CommandTransaction, input: unknown,
    isolation: 'unstarted' | 'uncertain'): AttemptApplicationResult;
}

/** Owns a short committing transaction; no Runtime, Git, filesystem or process I/O. */
export function createSqliteAttemptLifecycleStore(session: SqliteStorageSession, options: {
  readonly workspaceAuthority: WorkWorkspaceAuthority;
  readonly stopVerifier?: Pick<WorkResourceStopVerifier, 'inspect'>;
  readonly nowUtcMs?: () => number;
}): SqliteAttemptLifecycleStore {
  const operation = 'AttemptLifecycle.apply';
  const db = session.database;
  const attempts = createSqliteAttemptAccess(session);
  const executions = createSqliteExecutionAccess(session, options);
  const atomic = createSqliteAtomicCommandStore(session, options);
  const resources = createSqliteWorkResourceAccess(session, options);
  const dag = createSqliteTaskDagStore(session);
  const sessions = createSqliteWorkSessionStore(session, options);
  function applyInTransaction(transaction: CommandTransaction, input: unknown, stopEvidence?: unknown,
    preparationIsolated = false): AttemptApplicationResult {
      if (!db.inTransaction) throw new TypeError('Attempt lifecycle primitive requires a write transaction');
      const valid = validateAttemptNotification(input);
      const identity: WorkResourceIdentity = { projectId: valid.projectId, attemptId: valid.attemptId,
        owner: valid.owner, hostInstanceId: valid.hostInstanceId, executionVersion: valid.executionVersion };
      const digest = createHash('sha256').update(stableStringify(valid)).digest('hex');
      const runtime = valid.kind === 'runtime_settled' ? valid.runtime : null;
      const targetStatus = valid.kind === 'executing' ? 'executing'
        : runtime !== null ? runtime.control !== undefined && runtime.stopped?.confirmed !== true ? 'interrupted'
          : runtime.control?.reason === 'user_cancelled' || runtime.control?.reason === 'service_close' ? 'cancelled'
          : runtime.failure === null && runtime.result?.terminal === 'completed' ? 'verifying' : 'failed'
        : valid.kind === 'preparation_failed' || (valid.kind === 'runtime_completed' && valid.exitCode !== 0) ? 'failed' : 'verifying';
        const now = (options.nowUtcMs ?? Date.now)();
        if (!Number.isSafeInteger(now) || now < 1) throw new StorageError('validation', operation, 'Invalid lifecycle clock');
        const row = db.prepare<[string], { project_id: string }>('SELECT project_id FROM attempts WHERE id = ?').get(valid.attemptId);
        const ignored = (reason: 'stale_execution_identity' | 'invalid_transition' | 'notification_id_reused'): AttemptApplicationResult => {
          // Never retain raw untrusted identifiers, messages, output, usage or credentials.
          if (row?.project_id === valid.projectId) db.prepare(`INSERT OR IGNORE INTO attempt_notification_diagnostics
            (id, project_id, attempt_id, notification_digest, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), valid.projectId, valid.attemptId, digest, reason, now);
          return { disposition: 'ignored', attemptId: valid.attemptId, status: null, reason,
            waitingFor: null, runtimeCompleted: false, resultSaved: false, stopConfirmed: false, eventId: null };
        };
        if (row?.project_id !== valid.projectId) return ignored('stale_execution_identity');
        const attempt = attempts.getAttempt(valid.projectId, valid.attemptId);
        const task = db.prepare<[string], { execution_version: number; status: string; manual_block: number }>(
          'SELECT execution_version, status, manual_block FROM tasks WHERE id = ?').get(attempt.taskId)!;
        if (attempt.owner !== valid.owner || attempt.hostInstanceId !== valid.hostInstanceId
          || attempt.executionVersion !== valid.executionVersion || task.execution_version !== valid.executionVersion
          || attempt.taskId !== valid.taskId || attempt.runId !== valid.runId) return ignored('stale_execution_identity');
        const previous = db.prepare<[string, string], { request_digest: string; receipt: string }>(
          'SELECT request_digest, receipt FROM attempt_notifications WHERE attempt_id = ? AND notification_id = ?')
          .get(valid.attemptId, valid.notificationId);
        if (previous) {
          if (previous.request_digest !== digest) return ignored('notification_id_reused');
          try {
            const context = { operation };
            const receipt = requirePlainObject(JSON.parse(previous.receipt), context, 'receipt');
            rejectUnknownKeys(receipt, ['disposition', 'attemptId', 'status', 'reason', 'waitingFor', 'runtimeCompleted', 'resultSaved', 'stopConfirmed', 'eventId'], context, 'receipt');
            validateStableId(receipt.eventId, context, 'eventId');
            if (receipt.disposition !== 'applied' || receipt.attemptId !== attempt.id || receipt.reason !== null
              || receipt.status !== targetStatus
              || (runtime !== null && targetStatus === 'verifying'
                ? !['approval', 'verification_not_assembled', 'recording_required', 'execution_uncertain'].includes(String(receipt.waitingFor))
                : valid.kind === 'runtime_completed' && valid.exitCode === 0
                  ? !['approval', 'verification_not_assembled'].includes(String(receipt.waitingFor)) : receipt.waitingFor !== null)
              || ![receipt.runtimeCompleted, receipt.resultSaved, receipt.stopConfirmed].every(v => typeof v === 'boolean')
              || receipt.runtimeCompleted !== (runtime !== null ? runtime.result?.terminal === 'completed' : valid.kind === 'runtime_completed')
              || receipt.resultSaved !== (valid.kind !== 'executing')
              || (valid.kind === 'executing' && receipt.stopConfirmed !== false)) throw new Error('invalid_receipt');
            return { ...receipt, disposition: 'replayed' } as unknown as AttemptApplicationResult;
          } catch { throw new StorageError('corrupt', operation, 'Invalid persisted Attempt notification receipt'); }
        }
        if (!ACTIVE_ATTEMPT_STATUSES.includes(attempt.status as typeof ACTIVE_ATTEMPT_STATUSES[number])
          || task.status !== 'running'
          || (valid.kind === 'executing' && (attempt.status !== 'preparing' || attempt.executionStage !== 'runtime'))
          || (valid.kind === 'preparation_failed' && attempt.status !== 'preparing')
          || (valid.kind === 'runtime_completed' && attempt.status !== 'executing')
          || (runtime !== null && !['preparing', 'executing'].includes(attempt.status))) return ignored('invalid_transition');
        if (now < (attempt.startedAtUtcMs ?? attempt.createdAtUtcMs)) throw new StorageError('validation', operation, 'Lifecycle clock precedes Attempt');
        const occupied = resources.read(identity);
        if (valid.kind === 'executing' && (occupied.leases.length !== 3 || occupied.leases.some(l => l.state !== 'held' || l.leaseUntilUtcMs <= now)
          || occupied.invocationId === null || occupied.processIdentity === null)) return ignored('invalid_transition');
        if (valid.kind !== 'executing') transaction.getArtifactInputRef(valid.projectId, valid.evidenceRef);
        let settlementRevision = attempt.revision;
        const workSession = runtime === null ? null : sessions.getWorkSession(valid.projectId, runtime.sessionId);
        if (runtime !== null) {
          if (workSession === null || workSession.attemptId !== attempt.id
            || !['reserved', 'started'].includes(workSession.status) || attempt.invocationId !== runtime.invocationId) return ignored('stale_execution_identity');
          if (runtime.recording.manifestRef !== null) transaction.getArtifactInputRef(valid.projectId, runtime.recording.manifestRef);
          const ended = sessions.applyWorkSessionProgressInTransaction(transaction, { ...identity, sessionId: runtime.sessionId,
            expectedRevision: workSession.revision, kind: 'ended', executionStage: targetStatus === 'verifying' ? 'verification' : 'runtime',
            resultRef: valid.kind === 'runtime_settled' ? valid.evidenceRef : null,
            recordingGaps: [...(!runtime.recording.complete ? ['recording_required'] : []), ...(!runtime.stopped?.confirmed ? ['stop_unconfirmed'] : [])] });
          if (runtime.stopped?.confirmed) sessions.applyWorkSessionProgressInTransaction(transaction, { ...identity,
            sessionId: runtime.sessionId, expectedRevision: ended.session.revision, kind: 'stopped' });
          settlementRevision = attempts.getAttempt(valid.projectId, valid.attemptId).revision;
        }
        const approval = verifyFeaturePlanApprovalInTransaction(transaction, valid.projectId, attempt.featureId);
        const view = dag.readTaskDagView(valid.projectId, attempt.runId);
        const graph = evaluateTaskDag(view, now);
        const snapshot = attempt.inputSnapshot.approval;
        const approvalWaiting = task.manual_block === 1 || !approval.validity.valid
          || approval.planDigest !== snapshot.planDigest || approval.checkPolicyDigest !== snapshot.checkPolicyDigest
          || approval.currentDecision?.id !== snapshot.decisionId || graph.reason === 'invalid_graph';
        let stopConfirmed = false;
        if (runtime !== null) {
          stopConfirmed = runtime.stopped?.confirmed === true;
          // Runtime stop is an observation, not authorization to release a workspace before verification/retention.
          if (!stopConfirmed || targetStatus !== 'verifying') resources.quarantineInTransaction(identity);
        } else if (valid.kind === 'preparation_failed') {
          const unstarted = !preparationIsolated && attempt.invocationId === null && attempt.startedAtUtcMs === null
            && attempt.executionStage === 'preflight' && occupied.leases.every(l => l.processIdentity === null);
          if (unstarted) {
            resources.releaseUnstartedInTransaction(identity);
            stopConfirmed = true;
          } else resources.quarantineInTransaction(identity);
          transaction.reclassifyTaskAttemptAsInfrastructure({ projectId: valid.projectId, taskId: valid.taskId,
            attemptKey: valid.attemptId, reason: `preparation_failed:${valid.errorKind}` });
        } else if (valid.kind === 'runtime_completed') {
          if (stopEvidence !== undefined) {
            resources.releaseStoppedInTransaction(identity, stopEvidence);
            stopConfirmed = true;
          } else resources.quarantineInTransaction(identity);
        }
        const status = targetStatus;
        const stage = valid.kind === 'executing' ? 'runtime' : valid.kind === 'preparation_failed' ? attempt.executionStage
          : targetStatus === 'verifying' ? 'verification' : 'runtime';
        const errorKind = runtime !== null ? targetStatus === 'cancelled' ? null : runtime.failure?.kind ?? (targetStatus === 'failed' ? 'runtime' : null)
          : valid.kind === 'preparation_failed' ? valid.errorKind
            : valid.kind === 'runtime_completed' && valid.exitCode !== 0 ? 'runtime' : null;
        const startedAt = attempt.startedAtUtcMs ?? workSession?.startedAtUtcMs ?? null;
        const changed = db.prepare(`UPDATE attempts SET status = ?, execution_stage = ?, error_kind = ?, diagnostic_ref = ?,
          started_at = ?, ended_at = ?, exit_code = ?, duration_ms = ?, usage_summary = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND revision = ?
          AND status IN ('preparing', 'executing', 'verifying')
          AND EXISTS (SELECT 1 FROM tasks WHERE id = attempts.task_id AND execution_version = ? AND status = 'running')`)
          .run(status, stage, errorKind, valid.kind === 'executing' ? null : valid.evidenceRef,
            valid.kind === 'executing' ? now : startedAt, valid.kind === 'executing' ? null : now,
            runtime !== null ? runtime.result?.exitCode ?? null : valid.kind === 'runtime_completed' ? valid.exitCode : null,
            runtime !== null ? runtime.result?.durationMs ?? null : valid.kind === 'executing' || startedAt === null ? null : now - startedAt,
            // Preserve synthetic observations with their basis in the result Artifact; never book them as real usage.
            runtime?.result?.usage?.basis === 'reported' ? JSON.stringify({ schemaVersion: 1,
              inputTokens: runtime.result.usage.inputTokens, outputTokens: runtime.result.usage.outputTokens,
              costMicros: runtime.result.usage.costUsdMicros,
              currency: runtime.result.usage.costUsdMicros === null ? null : 'USD' }) : null,
            now, attempt.id, valid.owner, valid.hostInstanceId, valid.executionVersion, settlementRevision, valid.executionVersion);
        if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Attempt CAS failed');
        // Never clear manual_block, grant acceptance or reset budgets, even for exitCode 0.
        const taskChanged = db.prepare(`UPDATE tasks SET status = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND execution_version = ? AND status = 'running'`)
          .run(status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'running', now, valid.taskId, valid.executionVersion);
        if (taskChanged.changes !== 1) throw new StorageError('conflict', operation, 'Task execution CAS failed');
        const counters = transaction.getTaskExecutionCounters(valid.projectId, valid.taskId);
        const eventId = executions.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: ATTEMPT_UPDATED_EVENT_TYPE,
          aggregateType: 'task', aggregateId: valid.taskId, aggregateRevision: counters.revision, payload: { updated: true } });
        const waitingFor: AttemptApplicationResult['waitingFor'] = runtime !== null && targetStatus === 'verifying'
          ? approvalWaiting ? 'approval' : !stopConfirmed ? 'execution_uncertain'
            : !runtime.recording.complete ? 'recording_required' : 'verification_not_assembled'
          : valid.kind === 'runtime_completed' && valid.exitCode === 0
            ? approvalWaiting ? 'approval' : 'verification_not_assembled' : null;
        if (runtime !== null) {
          // A single transaction fences the result, Session, phase, pause, occupancy and notification event.
          db.prepare(`UPDATE runs SET status = 'paused', reason = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND project_id = ? AND status IN ('queued', 'running', 'pausing')`)
            .run(waitingFor ?? runtime.control?.reason ?? runtime.failure?.reason ?? runtime.result?.reason ?? 'runtime_failed', now, valid.runId, valid.projectId);
        }
        const receipt: AttemptApplicationResult = { disposition: 'applied', attemptId: attempt.id, status, reason: null,
          waitingFor, runtimeCompleted: runtime !== null ? runtime.result?.terminal === 'completed' : valid.kind === 'runtime_completed',
          resultSaved: valid.kind !== 'executing', stopConfirmed, eventId };
        db.prepare(`INSERT INTO attempt_notifications (id, project_id, attempt_id, notification_id, request_digest, receipt)
          VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), valid.projectId, attempt.id, valid.notificationId, digest, JSON.stringify(receipt));
        return receipt;
  }
  return {
    apply(input, stopEvidence) {
      validateAttemptNotification(input);
      return atomic.transact(operation, transaction => applyInTransaction(transaction, input, stopEvidence));
    },
    recordWorkspaceRetentionInTransaction(transaction, identity, expectedRevision, evidenceRef) {
      if (!db.inTransaction) throw new TypeError('Attempt retention requires a write transaction');
      resources.read(identity);
      transaction.getArtifactInputRef(identity.projectId, evidenceRef);
      const changed = db.prepare(`UPDATE attempts SET diagnostic_ref = ?, revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND id = ? AND owner_id = ? AND host_instance_id = ? AND execution_version = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM tasks WHERE id = attempts.task_id AND execution_version = ?)`)
        .run(evidenceRef, (options.nowUtcMs ?? Date.now)(), identity.projectId, identity.attemptId, identity.owner,
          identity.hostInstanceId, identity.executionVersion, expectedRevision, identity.executionVersion);
      if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Attempt retention CAS failed');
    },
    applyPreparationFailureInTransaction(transaction, input, isolation) {
      if (validateAttemptNotification(input).kind !== 'preparation_failed'
        || !['unstarted', 'uncertain'].includes(isolation)) throw new TypeError('Expected trusted preparation failure');
      return applyInTransaction(transaction, input, undefined, isolation === 'uncertain');
    },
  };
}
