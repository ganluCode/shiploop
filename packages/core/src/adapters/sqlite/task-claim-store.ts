import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { evaluateTaskDag } from '../../application/task-dag.js';
import { mergeEffectiveSettings } from '../../application/effective-settings.js';
import { validateAttemptRecord, validateWorkspaceLeaseRecord } from '../../ports/attempt-store.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { TASK_CLAIMED_EVENT_TYPE } from '../../ports/execution-store.js';
import { computeExecutionPermissionsDigest, TRUSTED_PROJECT_PERMISSIONS_READER, type ExecutionPermissionsReader } from '../../ports/execution-input-prepare.js';
import { validateTaskClaimInput, type TaskClaimStore, type TaskClaimReceipt } from '../../ports/task-claim.js';
import { requirePlainObject, rejectUnknownKeys, validateStableId } from '../../ports/validation.js';
import type { WorkWorkspaceAuthority } from '../../ports/work-resources.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqliteTaskDagStore } from './task-dag-store.js';
import { createSqliteWorkResourceAccess } from './work-resources.js';
import type { SqliteStorageSession } from './session.js';

const operation = 'TaskClaim.claimTask';

/** No workspace preparation, Git, process or Runtime I/O belongs in this adapter. */
export function createSqliteTaskClaimStore(session: SqliteStorageSession, options: {
  readonly workspaceAuthority: WorkWorkspaceAuthority;
  /** Trusted synchronous in-memory policy reader; must not perform external I/O. */
  readonly permissions?: ExecutionPermissionsReader;
  readonly nowUtcMs?: () => number;
}): TaskClaimStore {
  const db = session.database;
  const attempts = createSqliteAttemptAccess(session);
  const dag = createSqliteTaskDagStore(session);
  const clock = options.nowUtcMs ?? Date.now;
  const fail = (reason: string, extra: Record<string, unknown> = {}): never => {
    throw new StorageError('conflict', operation, `Task claim rejected: ${reason}`, { details: { reason, ...extra } });
  };
  function readReceipt(json: string): TaskClaimReceipt {
    try {
      const context = { operation };
      const value = requirePlainObject(JSON.parse(json), context, 'receipt');
      rejectUnknownKeys(value, ['schemaVersion', 'claimKey', 'batchId', 'attempt', 'taskRevision',
        'reservationId', 'leases', 'counts', 'eventId'], context, 'receipt');
      for (const field of ['claimKey', 'batchId', 'reservationId', 'eventId']) validateStableId(value[field], context, field);
      const raw = value as unknown as TaskClaimReceipt;
      requirePlainObject(raw.counts, context, 'counts');
      const attempt = validateAttemptRecord(raw.attempt);
      const leases = raw.leases.map(validateWorkspaceLeaseRecord);
      if (raw.schemaVersion !== 1 || typeof raw.claimKey !== 'string' || typeof raw.batchId !== 'string'
        || typeof raw.reservationId !== 'string' || typeof raw.eventId !== 'string'
        || !Number.isSafeInteger(raw.taskRevision) || raw.taskRevision < 1
        || Object.keys(raw.counts).sort().join(',') !== 'batchAttempts,codeAttempts,runAttempts,taskAttempts'
        || Object.values(raw.counts).some(n => !Number.isSafeInteger(n) || n < 0)
        || raw.counts.taskAttempts !== attempt.number || raw.counts.codeAttempts > raw.counts.taskAttempts
        || raw.counts.runAttempts > raw.counts.batchAttempts
        || attempt.status !== 'preparing'
        || leases.length !== 3 || leases[0]?.resourceKey !== 'global:execution'
        || leases[1]?.resourceKey !== `project:${attempt.projectId}:work`
        || leases.map(l => l.resourceKind).join(',') !== 'global,project,workspace'
        || leases.some(l => l.owner !== attempt.id || l.projectId !== attempt.projectId
          || l.hostInstanceId !== attempt.hostInstanceId || l.executionVersion !== attempt.executionVersion
          || l.leaseUntilUtcMs !== attempt.leaseUntilUtcMs || l.state !== 'held')) throw new Error('invalid_receipt');
      return { ...raw, attempt, leases };
    } catch (cause) {
      throw new StorageError('corrupt', operation, 'Invalid persisted Task claim receipt', { cause });
    }
  }
  return {
    claimTask(input) {
      // A savepoint cannot issue a committed receipt to its caller.
      if (!session.isOpen()) throw new StorageError('corrupt', operation, 'Storage session is closed');
      if (db.inTransaction) throw new TypeError('claimTask must own its committing transaction');
      const valid = validateTaskClaimInput(input, token => options.workspaceAuthority.inspect(token));
      const requestDigest = createHash('sha256').update(stableStringify(valid)).digest('hex');
      try {
        return session.transactWrite(operation, () => {
          const existing = db.prepare<[string], { project_id: string; attempt_id: string; request_digest: string; receipt: string }>(
            'SELECT project_id, attempt_id, request_digest, receipt FROM task_claim_receipts WHERE id = ?',
          ).get(valid.claimKey);
          if (existing) {
            if (existing.project_id !== valid.projectId || existing.request_digest !== requestDigest) fail('claim_key_reused');
            const receipt = readReceipt(existing.receipt);
            if (receipt.claimKey !== valid.claimKey || receipt.attempt.id !== existing.attempt_id
              || receipt.attempt.projectId !== valid.projectId || receipt.attempt.runId !== valid.runId
              || receipt.attempt.taskId !== valid.taskId || receipt.attempt.owner !== valid.owner
              || receipt.attempt.hostInstanceId !== valid.hostInstanceId
              || receipt.attempt.executionVersion !== valid.executionVersion + 1
              || receipt.attempt.leaseUntilUtcMs !== valid.leaseUntilUtcMs
              || !isDeepStrictEqual(receipt.attempt.inputSnapshot, valid.inputSnapshot)) {
              throw new StorageError('corrupt', operation, 'Claim receipt identity mismatch');
            }
            return { replayed: true, receipt };
          }
          const now = clock();
          if (!Number.isSafeInteger(now) || now < 1) throw new StorageError('validation', operation, 'Invalid claim clock');
          if (valid.leaseUntilUtcMs <= now) throw new StorageError('validation', operation, 'Expired new claim lease');
          const view = dag.readTaskDagView(valid.projectId, valid.runId);
          if (view.run.pauseRequestedAtUtcMs !== null) fail('not_ready', { eligibility: 'run_control_blocked' });
          if (view.batch.pauseRequestedAtUtcMs !== null) fail('not_ready', { eligibility: 'batch_control_blocked' });
          const task = view.plan.tasks.find(t => t.id === valid.taskId);
          const fact = view.facts.find(t => t.taskId === valid.taskId);
          if (!task || !fact || fact.kind !== 'coding') return fail('not_ready', { eligibility: 'task_outside_scope' });
          if (task.revision !== valid.expectedRevision || fact.executionVersion !== valid.executionVersion) fail('stale_task');
          if ([fact.executionVersion, fact.attemptCounter, task.revision, view.batch.attemptsCreated,
            view.batch.revision, view.run.attemptsCreated, view.run.revision].some(n => n >= Number.MAX_SAFE_INTEGER - 2)) {
            fail('counter_overflow');
          }
          const ready = evaluateTaskDag(view, now);
          if (!ready.readyTaskIds.includes(valid.taskId)) {
            const reason = ready.tasks.find(t => t.taskId === valid.taskId)?.reason ?? ready.reason;
            fail(reason === 'resource_busy' ? 'resource_busy' : 'not_ready', { eligibility: reason });
          }
          const snapshot = valid.inputSnapshot;
          const approval = view.batch.configSnapshot.approval as Record<string, unknown>;
          const strategies = view.batch.configSnapshot.tasks as { taskId: string; digest: string }[];
          const permissions = view.batch.configSnapshot.permissions as { taskId: string; digest: string }[];
          if (snapshot.projectId !== valid.projectId || snapshot.featureId !== view.plan.feature.id
            || snapshot.taskId !== valid.taskId || snapshot.approval.planDigest !== approval.planDigest
            || snapshot.approval.decisionId !== approval.decisionId
            || snapshot.approval.checkPolicyDigest !== approval.checkPolicyDigest
            || snapshot.digests.strategyCopyDigest !== strategies.find(t => t.taskId === valid.taskId)?.digest
            || snapshot.digests.permissionsDigest !== permissions.find(t => t.taskId === valid.taskId)?.digest) {
            fail('not_ready', { eligibility: 'input_identity_changed' });
          }
          const face = (options.permissions ?? TRUSTED_PROJECT_PERMISSIONS_READER)({
            projectId: valid.projectId, featureId: task.featureId, taskId: task.id,
          });
          if (!face || !Array.isArray(face.grants) || face.grants.length > 256
            || face.grants.some(g => typeof g !== 'string' || g.length > 256)) {
            throw new StorageError('validation', operation, 'Invalid trusted permissions face');
          }
          if (computeExecutionPermissionsDigest(face.grants) !== snapshot.digests.permissionsDigest) {
            fail('not_ready', { eligibility: 'permissions_changed' });
          }
          const requiredIds = new Set([...view.plan.feature.sourceRefs, ...task.requirementsRefs].map(ref => ref.artifactId));
          const required = view.inputs.filter(ref => requiredIds.has(ref.artifactId));
          const supplied = snapshot.requiredInputs.map(ref => ({ artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash }))
            .sort((a, b) => a.artifactId < b.artifactId ? -1 : 1);
          if (!isDeepStrictEqual(required, supplied)) fail('not_ready', { eligibility: 'required_inputs_changed' });
          for (const ref of [...Object.values(snapshot.group), ...snapshot.requiredInputs]) {
            if (!db.prepare('SELECT id FROM artifacts WHERE project_id = ? AND id = ? AND status = ? AND version = ? AND content_hash = ? AND size_bytes = ? AND storage_locator = ? AND media_type = ?')
              .get(valid.projectId, ref.artifactId, 'ready', ref.version, ref.contentHash, ref.sizeBytes, ref.locator, ref.mediaType)) {
              fail('not_ready', { eligibility: 'input_artifact_changed' });
            }
          }
          const attemptId = valid.attemptId ?? randomUUID();
          const executionVersion = fact.executionVersion + 1;
          const number = fact.attemptCounter + 1;
          // F-012：返工纪律在同 worktree 有限增量返工上的落实——
          // · 有历史（最近终态 Attempt 为已计费代码尝试）的认领必须携带返工快照；
          // · 返工快照必须绑定预生成的新 Attempt（attemptId 一致）；
          // · previousAttemptId 必须等于同 Task 直接上一 Attempt 且其已终态；
          // · 无历史/最近为未启动基础设施替换（重分类 infrastructure）时携带返工
          //   快照一律拒绝（不能伪造返工身份绕过首次纪律，也不能把基础设施
          //   替换伪装成代码返工）；基础设施替换沿用原快照、不算代码返工。
          const history = [...attempts.listTaskAttempts(valid.projectId, valid.taskId)]
            .sort((left, right) => left.number - right.number);
          const latest = history[history.length - 1];
          const latestReservation = latest === undefined ? null
            : (db.prepare<[string, string, string], { classification: string }>(
                'SELECT classification FROM task_attempt_reservations WHERE project_id = ? AND task_id = ? AND attempt_key = ?')
              .get(valid.projectId, valid.taskId, latest.id) ?? null);
          /* 缺失记账行不默认可替换：fail-closed 视为代码尝试（必须返工快照）。 */
          const latestIsCode = latest !== undefined
            && (latestReservation === null || latestReservation.classification === 'code');
          const rework = snapshot.rework;
          if (rework === undefined) {
            if (latestIsCode) fail('not_ready', { eligibility: 'rework_input_required' });
          } else {
            if (!latestIsCode) fail('not_ready', { eligibility: 'rework_without_history' });
            if (valid.attemptId === undefined || rework.attemptId !== valid.attemptId) {
              fail('not_ready', { eligibility: 'rework_attempt_identity_mismatch' });
            }
            const previous = latest!;
            if (rework.previousAttemptId !== previous.id || rework.previousTaskId !== valid.taskId
              || ['preparing', 'executing', 'verifying'].includes(previous.status)) {
              fail('not_ready', { eligibility: 'rework_previous_attempt_mismatch' });
            }
            if (previous.executionVersion >= executionVersion) fail('not_ready', { eligibility: 'stale_task' });
          }
          const changed = db.prepare("UPDATE tasks SET status = 'running', execution_version = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ? AND execution_version = ? AND status = 'pending' AND manual_block = 0")
            .run(executionVersion, now, task.id, valid.projectId, valid.expectedRevision, valid.executionVersion);
          if (changed.changes !== 1) fail('stale_task');
          db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
            number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(attemptId, now, now, valid.projectId, task.featureId, valid.runId, task.id, number,
              valid.owner, valid.hostInstanceId, executionVersion, valid.leaseUntilUtcMs,
              JSON.stringify(snapshot), snapshot.digests.snapshotDigest, snapshot.group.snapshot.artifactId);
          const execution = createSqliteExecutionAccess(session, { nowUtcMs: () => now });
          const maxAttemptsPerTask = mergeEffectiveSettings({ global: view.settings.global, project: view.settings.project })
            .policies.executionLimits?.value.maxAttemptsPerTask ?? null;
          const reservation = execution.reserveTaskAttemptInTransaction({ projectId: valid.projectId, batchId: view.batch.id,
            runId: valid.runId, taskId: task.id, attemptKey: attemptId, maxAttemptsPerTask });
          const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: options.workspaceAuthority, nowUtcMs: () => now });
          const occupied = resources.acquireInTransaction({ projectId: valid.projectId, attemptId,
            owner: valid.owner, hostInstanceId: valid.hostInstanceId, executionVersion }, valid.workspace, valid.leaseUntilUtcMs);
          const counters = execution.getTaskExecutionCountersInTransaction(valid.projectId, task.id);
          const eventId = execution.appendExecutionEventInTransaction({ projectId: valid.projectId, eventType: TASK_CLAIMED_EVENT_TYPE,
            aggregateType: 'task', aggregateId: task.id, aggregateRevision: counters.revision, payload: { claimed: true } });
          const receipt: TaskClaimReceipt = { schemaVersion: 1, claimKey: valid.claimKey, batchId: view.batch.id,
            attempt: attempts.getAttempt(valid.projectId, attemptId), taskRevision: counters.revision,
            reservationId: reservation.id, leases: occupied.leases, counts: { batchAttempts: view.batch.attemptsCreated + 1,
              runAttempts: view.run.attemptsCreated + 1, taskAttempts: counters.attemptCounter, codeAttempts: counters.codeAttemptsUsed }, eventId };
          db.prepare('INSERT INTO task_claim_receipts (id, project_id, attempt_id, request_digest, receipt) VALUES (?, ?, ?, ?, ?)')
            .run(valid.claimKey, valid.projectId, attemptId, requestDigest, JSON.stringify(receipt));
          return { replayed: false, receipt };
        });
      } catch (error) {
        if (error instanceof StorageError || error instanceof TypeError) throw error;
        if (typeof (error as { code?: unknown })?.code === 'string'
          && String((error as { code: string }).code).startsWith('SQLITE_CONSTRAINT')) {
          throw new StorageError('conflict', operation, 'Claim transaction rejected by a persistence constraint', {
            details: { reason: 'claim_constraint' }, cause: error,
          });
        }
        throw error;
      }
    },
  };
}
