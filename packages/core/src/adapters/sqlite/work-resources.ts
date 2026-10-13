import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '../../ports/errors.js';
import { validateNonNegativeInteger } from '../../ports/validation.js';
import {
  validateWorkProcessIdentity, validateWorkResourceIdentity,
  type WorkResourceAccess, type WorkResourceIdentity, type WorkResourceSnapshot, type WorkWorkspaceAuthority, type WorkResourceStopVerifier,
} from '../../ports/work-resources.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteStateAccess, transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

/** Short synchronous primitives; F-004 can acquire in the same transaction as claim/budget. */
export function createSqliteWorkResourceAccess(session: SqliteStorageSession, options: {
  readonly workspaceAuthority: WorkWorkspaceAuthority;
  readonly stopVerifier?: Pick<WorkResourceStopVerifier, 'inspect'>;
  readonly nowUtcMs?: () => number;
}): WorkResourceAccess {
  const operation = 'WorkResources';
  const attempts = createSqliteAttemptAccess(session);
  const state = createSqliteStateAccess(session);
  const db = session.database;
  const fail = (kind: 'conflict' | 'ownership' | 'corrupt' | 'validation', reason: string): never => {
    throw new StorageError(kind, operation, reason, { details: { reason } });
  };
  function time(value: unknown): number {
    if (!Number.isSafeInteger(value)) return fail('validation', 'invalid_timestamp');
    return validateNonNegativeInteger(value, { operation }, 'timestamp');
  }
  const now = () => time((options.nowUtcMs ?? Date.now)());
  function write() {
    if (!session.isOpen() || !db.inTransaction) throw new TypeError('Work resource mutation requires an open write transaction');
  }
  function current(identity: WorkResourceIdentity) {
    const attempt = attempts.getAttempt(identity.projectId, identity.attemptId);
    const task = db.prepare<[string], { execution_version: number }>('SELECT execution_version FROM tasks WHERE id = ?').get(attempt.taskId);
    if (attempt.owner !== identity.owner || attempt.hostInstanceId !== identity.hostInstanceId
      || attempt.executionVersion !== identity.executionVersion || task?.execution_version !== identity.executionVersion) {
      return fail('ownership', 'stale_execution_identity');
    }
    return attempt;
  }
  function snapshot(identity: WorkResourceIdentity): WorkResourceSnapshot {
    const attempt = current(identity);
    const leases = attempts.listWorkspaceLeases(identity.projectId).filter(lease => lease.owner === identity.attemptId);
    if (leases.some(lease => lease.hostInstanceId !== identity.hostInstanceId || lease.executionVersion !== identity.executionVersion)) {
      return fail('ownership', 'stale_lease_identity');
    }
    if (leases.length !== 0 && (leases.length !== 3 || leases[0]?.resourceKey !== 'global:execution'
      || leases[0]?.resourceKind !== 'global' || leases[1]?.resourceKey !== `project:${identity.projectId}:work`
      || leases[1]?.resourceKind !== 'project' || leases[2]?.resourceKind !== 'workspace'
      || leases[0]!.leaseUntilUtcMs !== attempt.leaseUntilUtcMs
      || leases.some(lease => lease.state !== leases[0]!.state || lease.leaseUntilUtcMs !== leases[0]!.leaseUntilUtcMs
        || !isDeepStrictEqual(lease.processIdentity, leases[0]!.processIdentity)))) {
      return fail('corrupt', 'incomplete_resource_group');
    }
    const process = leases[0]?.processIdentity;
    return { identity, invocationId: attempt.invocationId, leases,
      processIdentity: process?.schemaVersion === 2 ? validateWorkProcessIdentity({ launchId: process.launchId,
        pid: process.pid, processGroupId: process.processGroupId, startTime: process.startTime }) : null };
  }
  function occupied(identity: WorkResourceIdentity): WorkResourceSnapshot {
    const result = snapshot(identity);
    if (result.leases.length !== 3) return fail('conflict', 'not_occupied');
    return result;
  }
  function quarantine(identity: WorkResourceIdentity, timestamp = now()): WorkResourceSnapshot {
    const result = occupied(identity);
    if (result.leases[0]!.state !== 'quarantined') {
      db.prepare("UPDATE workspace_leases SET state = 'quarantined', revision = revision + 1, updated_at = ? WHERE owner_id = ? AND host_instance_id = ? AND execution_version = ?")
        .run(timestamp, identity.attemptId, identity.hostInstanceId, identity.executionVersion);
    }
    return snapshot(identity);
  }
  function live(identity: WorkResourceIdentity, timestamp = now()): WorkResourceSnapshot {
    const result = occupied(identity);
    return result.leases[0]!.leaseUntilUtcMs <= timestamp ? quarantine(identity, timestamp) : result;
  }
  function remove(identity: WorkResourceIdentity) {
    db.prepare('DELETE FROM workspace_leases WHERE owner_id = ? AND host_instance_id = ? AND execution_version = ?')
      .run(identity.attemptId, identity.hostInstanceId, identity.executionVersion);
  }
  return {
    read(input) {
      const identity = validateWorkResourceIdentity(input);
      if (!session.isOpen()) return fail('corrupt', 'closed_storage');
      return db.inTransaction ? snapshot(identity) : transactSqliteConsistentRead(session, operation, () => snapshot(identity));
    },
    acquireInTransaction(input, token, until) {
      write();
      const identity = validateWorkResourceIdentity(input), workspace = options.workspaceAuthority.inspect(token);
      const leaseUntil = time(until), timestamp = now();
      if (leaseUntil <= timestamp) return fail('validation', 'expired_new_lease');
      const binding = state.getRepositoryBinding(identity.projectId);
      if (workspace.binding.projectId !== identity.projectId) return fail('ownership', 'workspace_project_mismatch');
      if (!isDeepStrictEqual(binding, workspace.binding)) return fail('conflict', 'repository_binding_changed');
      const existing = snapshot(identity);
      if (existing.leases.length) {
        if (existing.leases[2]!.resourceKey !== workspace.resourceKey || existing.leases[0]!.state !== 'held'
          || existing.leases[0]!.leaseUntilUtcMs !== leaseUntil) return fail('conflict', 'resource_already_occupied');
        return live(identity, timestamp);
      }
      const attempt = current(identity);
      if (attempt.status !== 'preparing' || attempt.executionStage !== 'preflight' || attempt.invocationId !== null
        || attempt.startedAtUtcMs !== null) return fail('conflict', 'attempt_not_preflight');
      if (db.prepare('SELECT id FROM workspace_leases LIMIT 1').get()
        || db.prepare('SELECT id FROM baseline_occupancy WHERE holder_operation_id IS NOT NULL LIMIT 1').get()) {
        return fail('conflict', 'resource_busy');
      }
      const resources = [['global', 'global:execution'], ['project', `project:${identity.projectId}:work`], ['workspace', workspace.resourceKey]] as const;
      for (const [kind, key] of resources) {
        db.prepare(`INSERT INTO workspace_leases (id, created_at, updated_at, project_id, resource_key, resource_kind,
          owner_kind, owner_id, host_instance_id, execution_version, state, lease_until)
          VALUES (?, ?, ?, ?, ?, ?, 'attempt', ?, ?, ?, 'held', ?)`)
          .run(randomUUID(), timestamp, timestamp, identity.projectId, key, kind, identity.attemptId, identity.hostInstanceId, identity.executionVersion, leaseUntil);
      }
      db.prepare('UPDATE attempts SET lease_until = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(leaseUntil, timestamp, identity.attemptId);
      return snapshot(identity);
    },
    renewInTransaction(input, until) {
      write();
      const identity = validateWorkResourceIdentity(input), leaseUntil = time(until), timestamp = now();
      const result = live(identity, timestamp);
      if (result.leases[0]!.state === 'quarantined') return result;
      if (leaseUntil <= timestamp || leaseUntil < result.leases[0]!.leaseUntilUtcMs) return fail('validation', 'invalid_renewal');
      db.prepare('UPDATE workspace_leases SET lease_until = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND host_instance_id = ? AND execution_version = ?')
        .run(leaseUntil, timestamp, identity.attemptId, identity.hostInstanceId, identity.executionVersion);
      db.prepare('UPDATE attempts SET lease_until = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(leaseUntil, timestamp, identity.attemptId);
      return snapshot(identity);
    },
    quarantineInTransaction(input) {
      write(); return quarantine(validateWorkResourceIdentity(input));
    },
    expireInTransaction() {
      write();
      // Never delete on expiry. Every gate of the expired group remains reserved.
      const timestamp = now();
      const expired = db.prepare<[string, number], { owner_id: string }>('SELECT DISTINCT owner_id FROM workspace_leases WHERE state = ? AND lease_until <= ?')
        .all('held', timestamp);
      for (const row of expired) {
        db.prepare("UPDATE workspace_leases SET state = 'quarantined', revision = revision + 1, updated_at = ? WHERE owner_id = ? AND state = 'held'")
          .run(timestamp, row.owner_id);
      }
      return expired.length;
    },
    beginLaunchInTransaction(input) {
      write();
      const identity = validateWorkResourceIdentity(input), timestamp = now(), result = live(identity, timestamp);
      if (result.leases[0]!.state === 'quarantined') return { authorized: false, invocationId: null };
      const attempt = current(identity);
      if (attempt.status !== 'preparing' || attempt.executionStage !== 'preflight' || attempt.invocationId !== null) return fail('conflict', 'launch_already_authorized');
      const invocationId = randomUUID();
      db.prepare("UPDATE attempts SET invocation_id = ?, execution_stage = 'runtime', revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(invocationId, timestamp, identity.attemptId);
      return { authorized: true, invocationId };
    },
    confirmLaunchInTransaction(input, processInput) {
      write();
      const identity = validateWorkResourceIdentity(input), process = validateWorkProcessIdentity(processInput), timestamp = now();
      const result = live(identity, timestamp);
      if (result.invocationId === null) return fail('conflict', 'launch_not_authorized');
      if (result.leases[0]!.processIdentity !== null) {
        if (isDeepStrictEqual(result.processIdentity, process)) return { authorized: result.leases[0]!.state === 'held' };
        return fail('conflict', 'process_identity_immutable');
      }
      // Persist even late supervisor identities so quarantine can be safely finalized.
      // The caller must withhold workload acknowledgement when authorized is false.
      db.prepare('UPDATE workspace_leases SET process_identity = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND host_instance_id = ? AND execution_version = ?')
        .run(JSON.stringify({ schemaVersion: 2, ...process }), timestamp, identity.attemptId, identity.hostInstanceId, identity.executionVersion);
      return { authorized: result.leases[0]!.state === 'held' };
    },
    releaseUnstartedInTransaction(input) {
      write();
      const identity = validateWorkResourceIdentity(input), result = occupied(identity), attempt = current(identity);
      if (result.invocationId !== null || result.leases.some(l => l.processIdentity !== null)
        || attempt.startedAtUtcMs !== null || attempt.executionStage !== 'preflight'
        || attempt.status === 'executing' || attempt.status === 'verifying' || attempt.status === 'succeeded') return fail('conflict', 'launch_may_have_started');
      remove(identity);
    },
    releaseStoppedInTransaction(input, token) {
      write();
      const identity = validateWorkResourceIdentity(input), result = occupied(identity);
      if (!options.stopVerifier) return fail('validation', 'stop_verifier_not_assembled');
      const evidence = options.stopVerifier.inspect(token);
      if (!isDeepStrictEqual(evidence, result)) return fail('conflict', 'stale_stop_evidence');
      remove(identity);
    },
  };
}
