import { randomUUID } from 'node:crypto';
import { evaluateTaskDag } from '../../application/task-dag.js';
import { isPlanningAttemptSnapshot, type AttemptRecord } from '../../ports/attempt-store.js';
import { computeRunDispatchAuthorizationDigest } from '../../ports/execution-dispatch.js';
import { computeExecutionPermissionsDigest, TRUSTED_PROJECT_PERMISSIONS_READER,
  type ExecutionPermissionsReader } from '../../ports/execution-input-prepare.js';
import { computePlanningPermissionsDigest } from '../../ports/planning-input-prepare.js';
import { StorageError } from '../../ports/errors.js';
import { validateTaskClaimDispatch, type TaskClaimDispatch } from '../../ports/task-claim.js';
import { createSqliteExecutionSlotAccess } from './execution-slots.js';
import { createSqliteTaskDagStore } from './task-dag-store.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import type { SqliteStorageSession } from './session.js';

interface ClaimRow {
  id: string; claim_version: number; feature_id: string; owner_id: string;
  host_instance_id: string; state: string; lease_until: number;
}
const operation = 'RunDispatch.attempt';
function deny(reason: string): never {
  throw new StorageError('conflict', operation, `Run dispatch rejected: ${reason}`, { details: { reason } });
}

/** Trusted short transaction bridge. No new budget ledger, process or workspace I/O. */
export function createSqliteAttemptDispatchAccess(session: SqliteStorageSession, options: {
  readonly nowUtcMs: () => number;
  readonly permissions?: ExecutionPermissionsReader;
}) {
  const db = session.database;
  const slots = createSqliteExecutionSlotAccess(session, { nowUtcMs: options.nowUtcMs });
  function write() {
    if (!session.isOpen() || !db.inTransaction) throw new TypeError('Attempt dispatch requires an open transaction');
  }
  function authorized(attempt: AttemptRecord) {
    write();
    const execution = createSqliteExecutionAccess(session, { nowUtcMs: options.nowUtcMs });
    const run = execution.getExecutionRunInTransaction(attempt.projectId, attempt.runId);
    const batch = execution.getExecutionBatchInTransaction(attempt.projectId, run.batchId);
    if (!['queued', 'running'].includes(run.status) || !['queued', 'running'].includes(batch.status)
      || run.pauseRequestedAtUtcMs !== null || batch.pauseRequestedAtUtcMs !== null) deny('run_control_blocked');
    const intent = execution.getRunDispatchIntentInTransaction(attempt.projectId, attempt.runId);
    if (!intent || intent.featureId !== attempt.featureId || intent.batchId !== batch.id
      || intent.authorizationDigest !== computeRunDispatchAuthorizationDigest({ projectId: run.projectId,
        featureId: run.featureId, batchId: run.batchId, runId: run.id, purpose: run.purpose,
        scopeDigest: run.scopeDigest, workKey: run.workKey, dispatchOrdinal: run.dispatchOrdinal })) deny('dispatch_authorization_changed');
    return run;
  }
  function claim(attempt: AttemptRecord): ClaimRow | undefined {
    return db.prepare<[string, string], ClaimRow>(
      "SELECT id, claim_version, feature_id, owner_id, host_instance_id, state, lease_until FROM run_dispatch_claims WHERE project_id = ? AND run_id = ? AND state IN ('held', 'quarantined')",
    ).get(attempt.projectId, attempt.runId);
  }
  function held(attempt: AttemptRecord, row: ClaimRow | undefined, now: number): ClaimRow {
    if (!row) return deny('dispatch_ownership_missing');
    if (row.feature_id !== attempt.featureId || row.owner_id !== attempt.owner
      || row.host_instance_id !== attempt.hostInstanceId) deny('dispatch_owner_mismatch');
    if (row.state !== 'held' || row.lease_until <= now) deny('dispatch_lease_unverified');
    return row;
  }
  return {
    acquireInTransaction(attempt: AttemptRecord, expected?: TaskClaimDispatch,
      previousStoppedAttempt?: AttemptRecord): TaskClaimDispatch {
      authorized(attempt);
      const now = options.nowUtcMs();
      let row = claim(attempt);
      let newGeneration = row === undefined;
      if (row && (row.owner_id !== attempt.owner || row.host_instance_id !== attempt.hostInstanceId)
        && previousStoppedAttempt !== undefined && expected === undefined) {
        // Only trusted replacement paths may transfer ownership, after their old
        // Attempt stop/release checks. Expired or quarantined generations still refuse.
        const previous = held(previousStoppedAttempt, row, now);
        if (previousStoppedAttempt.runId !== attempt.runId || previousStoppedAttempt.projectId !== attempt.projectId
          || previousStoppedAttempt.featureId !== attempt.featureId || previousStoppedAttempt.endedAtUtcMs === null
          || !['failed', 'interrupted', 'succeeded'].includes(previousStoppedAttempt.status)
          || db.prepare('SELECT id FROM workspace_leases WHERE owner_id = ? LIMIT 1').get(previousStoppedAttempt.id)
          || db.prepare("SELECT id FROM attempts WHERE project_id = ? AND run_id = ? AND id <> ? AND status IN ('preparing', 'executing', 'verifying') LIMIT 1")
            .get(attempt.projectId, attempt.runId, attempt.id)) deny('dispatch_transfer_unverified');
        const oldSlot = slots.readActive({ projectId: attempt.projectId, runId: attempt.runId });
        if (!oldSlot) deny('dispatch_slot_not_held');
        slots.releaseInTransaction({ projectId: attempt.projectId, slotId: oldSlot.id, claimId: previous.id,
          claimVersion: previous.claim_version, ownerId: previous.owner_id, hostInstanceId: previous.host_instance_id });
        db.prepare("UPDATE run_dispatch_claims SET state = 'released', settled_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND state = 'held'")
          .run(now, now, previous.id);
        db.prepare(`INSERT INTO run_dispatch_claims (id, created_at, project_id, revision, updated_at,
          feature_id, run_id, claim_version, origin, resumed_from_claim_id, resumed_from_claim_version,
          owner_id, host_instance_id, acquired_at, lease_until, state)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'resume', ?, ?, ?, ?, ?, ?, 'held')`)
          .run(randomUUID(), now, attempt.projectId, now, attempt.featureId, attempt.runId, previous.claim_version + 1,
            previous.id, previous.claim_version, attempt.owner, attempt.hostInstanceId, now, attempt.leaseUntilUtcMs);
        row = claim(attempt);
        newGeneration = true;
      }
      if (!row) {
        // 已释放代次：只有同 Run 的显式继续（无旧活动 Attempt/工作区占用）才能追加
        // resume 代次；隔离代次必须由受信恢复流程处理，绝不隐式接管。
        const previous = db.prepare<[string, string], ClaimRow>(
          "SELECT id, claim_version, feature_id, owner_id, host_instance_id, state, lease_until FROM run_dispatch_claims WHERE project_id = ? AND run_id = ? ORDER BY claim_version DESC LIMIT 1",
        ).get(attempt.projectId, attempt.runId);
        if (expected || (previous !== undefined && (previous.state !== 'released'
          || previous.feature_id !== attempt.featureId))) deny('dispatch_recovery_required');
        if (previous === undefined) {
          const id = randomUUID();
          db.prepare(`INSERT INTO run_dispatch_claims (id, created_at, project_id, revision, updated_at,
            feature_id, run_id, claim_version, origin, owner_id, host_instance_id, acquired_at, lease_until, state)
            VALUES (?, ?, ?, 1, ?, ?, ?, 1, 'dispatch', ?, ?, ?, ?, 'held')`)
            .run(id, now, attempt.projectId, now, attempt.featureId, attempt.runId, attempt.owner,
              attempt.hostInstanceId, now, attempt.leaseUntilUtcMs);
        } else {
          // 同一 Run 的显式继续：仅当上一代已核对停止并释放、且没有其他活动
          // Attempt/工作区占用时才能追加受控代次；不重开终态 Run、不清理证据。
          if (db.prepare("SELECT id FROM attempts WHERE project_id = ? AND run_id = ? AND id <> ? AND status IN ('preparing', 'executing', 'verifying') LIMIT 1")
            .get(attempt.projectId, attempt.runId, attempt.id)) deny('dispatch_attempt_active');
          if (db.prepare(`SELECT l.id FROM workspace_leases l JOIN attempts a ON a.id = l.owner_id
            WHERE a.project_id = ? AND a.run_id = ? AND a.id <> ? LIMIT 1`)
            .get(attempt.projectId, attempt.runId, attempt.id)) deny('dispatch_workspace_retained');
          db.prepare(`INSERT INTO run_dispatch_claims (id, created_at, project_id, revision, updated_at,
            feature_id, run_id, claim_version, origin, resumed_from_claim_id, resumed_from_claim_version,
            owner_id, host_instance_id, acquired_at, lease_until, state)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'resume', ?, ?, ?, ?, ?, ?, 'held')`)
            .run(randomUUID(), now, attempt.projectId, now, attempt.featureId, attempt.runId,
              previous.claim_version + 1, previous.id, previous.claim_version, attempt.owner,
              attempt.hostInstanceId, now, attempt.leaseUntilUtcMs);
        }
        row = claim(attempt);
        newGeneration = true;
      }
      const current = held(attempt, row, now);
      if (expected && (expected.claimId !== current.id || expected.claimVersion !== current.claim_version)) deny('stale_dispatch_identity');
      const existingSlot = slots.readActive({ projectId: attempt.projectId, runId: attempt.runId });
      if (!newGeneration && !existingSlot && db.prepare(`SELECT r.id FROM task_claim_receipts r JOIN attempts a ON a.id = r.attempt_id
        WHERE a.project_id = ? AND a.run_id = ? LIMIT 1`).get(attempt.projectId, attempt.runId)) deny('dispatch_slot_not_held');
      if (expected && existingSlot?.id !== expected.slotId) deny('stale_dispatch_identity');
      if (current.lease_until < attempt.leaseUntilUtcMs) {
        db.prepare("UPDATE run_dispatch_claims SET lease_until = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND state = 'held'")
          .run(attempt.leaseUntilUtcMs, now, current.id);
      }
      const slotInput = { projectId: attempt.projectId, featureId: attempt.featureId, runId: attempt.runId,
        claimId: current.id, claimVersion: current.claim_version, ownerId: attempt.owner,
        hostInstanceId: attempt.hostInstanceId, leaseUntilUtcMs: attempt.leaseUntilUtcMs };
      const slot = slots.acquireInTransaction(slotInput);
      if (slot.leaseUntilUtcMs < attempt.leaseUntilUtcMs) {
        slots.renewInTransaction({ projectId: slot.projectId, slotId: slot.id, claimId: slot.claimId,
          claimVersion: slot.claimVersion, ownerId: slot.ownerId, hostInstanceId: slot.hostInstanceId }, attempt.leaseUntilUtcMs);
      }
      return { claimId: current.id, claimVersion: current.claim_version, slotId: slot.id };
    },
    assertLaunchInTransaction(attempt: AttemptRecord): void {
      const run = authorized(attempt);
      const now = options.nowUtcMs();
      // P05-1 / F-007：planning Attempt 不在编码 DAG（计划成员仅 coding），启动
      // 围栏按 Run purpose 与 planning Task 行级事实重核；其余派发/槽位/回执
      // 身份检查与编码共用（authorized 已重核 Run/Batch 控制与派发意图）。
      if (isPlanningAttemptSnapshot(attempt.inputSnapshot)) {
        if (run.purpose !== 'plan') deny('run_purpose_mismatch');
        const planningTask = db.prepare<[string], { kind: string; status: string; execution_version: number }>(
          'SELECT kind, status, execution_version FROM tasks WHERE id = ?').get(attempt.taskId);
        if (!planningTask || planningTask.kind !== 'planning' || planningTask.status !== 'running'
          || planningTask.execution_version !== attempt.executionVersion) deny('stale_task');
      } else {
        const eligibility = evaluateTaskDag(createSqliteTaskDagStore(session).readTaskDagView(attempt.projectId, attempt.runId), now);
        if (eligibility.reason !== 'resource_busy'
          || eligibility.tasks.find(task => task.taskId === attempt.taskId)?.reason !== 'resource_busy') deny(eligibility.reason);
      }
      const row = held(attempt, claim(attempt), now);
      const receipt = db.prepare<[string, string], { receipt: string }>(
        'SELECT receipt FROM task_claim_receipts WHERE project_id = ? AND attempt_id = ?',
      ).get(attempt.projectId, attempt.id);
      if (!receipt) deny('dispatch_attempt_link_missing');
      const persisted = JSON.parse(receipt.receipt) as { dispatch?: unknown; attempt?: AttemptRecord };
      if (!persisted.dispatch) deny('dispatch_attempt_link_missing');
      const link = validateTaskClaimDispatch(persisted.dispatch);
      if (link.claimId !== row.id || link.claimVersion !== row.claim_version
        || persisted.attempt?.id !== attempt.id || persisted.attempt?.executionVersion !== attempt.executionVersion
        || persisted.attempt?.owner !== attempt.owner || persisted.attempt?.hostInstanceId !== attempt.hostInstanceId) deny('stale_dispatch_identity');
      const slot = slots.read({ projectId: attempt.projectId, slotId: link.slotId });
      if (!slot || slot.state !== 'held' || slot.leaseUntilUtcMs <= now || slot.claimId !== row.id
        || slot.claimVersion !== row.claim_version || slot.ownerId !== attempt.owner
        || slot.hostInstanceId !== attempt.hostInstanceId || slot.runId !== attempt.runId
        || slot.featureId !== attempt.featureId) deny('dispatch_slot_not_held');
      const face = (options.permissions ?? TRUSTED_PROJECT_PERMISSIONS_READER)({ projectId: attempt.projectId,
        featureId: attempt.featureId, taskId: attempt.taskId });
      // P05-1 / F-007：planning 快照权限面为规划摘要域（与编码域不同源）。
      const permissionsDigest = isPlanningAttemptSnapshot(attempt.inputSnapshot)
        ? computePlanningPermissionsDigest(face.grants)
        : computeExecutionPermissionsDigest(face.grants);
      if (permissionsDigest !== attempt.inputSnapshot.digests.permissionsDigest) deny('permissions_changed');
    },
  };
}
