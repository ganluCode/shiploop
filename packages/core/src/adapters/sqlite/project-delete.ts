import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { assertTrustedPrincipal, authorizeCommand, authorizeCommandReplay, requireCapability, requireProjectVisible, type TrustedPrincipal } from '../../ports/authorization.js';
import { computeCommandRequestDigest, decideCommandReplay } from '../../ports/command-receipts.js';
import { createAcceptedReceipt, evaluateCommandTiming, PublicError, type CommandReceipt } from '../../ports/commands.js';
import type { MaintenanceWriteGate } from '../../ports/data-maintenance.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { hasProjectArchiveBlockers } from '../../ports/project-lifecycle.js';
import { PROJECT_DELETE_POLICY, computeProjectDeletePreviewDigest } from '../../ports/project-delete-preview.js';
import { PROJECT_DELETE_STEPS, type ProjectDeleteExecutorIdentity, type ProjectDeleteManifest, type ProjectDeleteOperation, type ProjectDeleteStore } from '../../ports/project-delete.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';
import { readProjectArchiveCloseoutInDatabase } from './project-lifecycle.js';
import { computeProjectDeleteDatabaseDigest, projectDeleteOwnershipPredicate, quoteSqliteIdentifier as quote } from './project-delete-snapshot.js';
import { createSqliteStateAccess } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OP = 'project.delete.confirm';
const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
function conflict(reason: string): never { throw new PublicError('conflict', OP, undefined, { details: { reason } }); }
function authorize(principal: TrustedPrincipal, projectId: string): void {
  assertTrustedPrincipal(principal);
  requireCapability(principal, 'project.lifecycle.write', OP);
  requireProjectVisible(principal, projectId, OP);
}
function assertNoUncertainWriters(db: Database, projectId: string): void {
  const queries = [
    "SELECT 1 FROM feature_resource_leases WHERE project_id = ? AND state IN ('held','quarantined') LIMIT 1",
    "SELECT 1 FROM workspace_operations WHERE project_id = ? AND status IN ('pending','blocked') LIMIT 1",
    "SELECT 1 FROM git_operations WHERE project_id = ? AND status IN ('pending','unknown') LIMIT 1",
    "SELECT 1 FROM verification_batches WHERE project_id = ? AND status = 'running' LIMIT 1",
    'SELECT 1 FROM baseline_occupancy o JOIN baseline_operations b ON b.id = o.holder_operation_id WHERE b.project_id = ? LIMIT 1',
  ];
  for (const sql of queries) {
    if (db.prepare(sql).get(projectId) !== undefined) conflict(`active_execution:${sql.split(' FROM ')[1]!.split(' ')[0]}`);
  }
}

interface OperationRow {
  id: string; target_project_id: string; principal_id: string; status: ProjectDeleteOperation['status'];
  owner_id: string | null; fence: number; manifest_digest: string; manifest_json: string | null; failed_step: string | null;
}

/** Derive child-before-parent order from real FK metadata. Cycles (e.g. project ↔
 * binding and Run ↔ Attempt) use deferred checks inside this one transaction.
 * Foreign keys remain ON and foreign_key_check must be empty before commit.
 */
function deletionOrder(db: Database): string[] {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map(row => row.name).filter(name => name === 'projects' || name === 'verification_processes'
      || (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).some(c => c.name === 'project_id'));
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (parent: string): void => {
    if (visited.has(parent)) return;
    visited.add(parent);
    for (const child of tables) {
      if ((db.prepare(`PRAGMA foreign_key_list(${quote(child)})`).all() as { table: string }[]).some(fk => fk.table === parent)) visit(child);
    }
    order.push(parent);
  };
  visit('projects');
  for (const table of tables) visit(table);
  // verification_processes has no project_id: its parent must still be present
  // when the deletion predicate and retention guard evaluate.
  return ['verification_processes', ...order.filter(table => table !== 'verification_processes')];
}

export function createSqliteProjectDeleteStore(session: SqliteStorageSession, options: { nowUtcMs?: () => number; maintenanceGate?: MaintenanceWriteGate } = {}): ProjectDeleteStore {
  const db = session.database;
  const now = options.nowUtcMs ?? Date.now;
  const receipts = createSqliteCommandReceiptAccess(session, { nowUtcMs: now });
  const readRow = (id: string): OperationRow => {
    const row = db.prepare('SELECT * FROM project_delete_operations WHERE id = ?').get(id) as OperationRow | undefined;
    if (!row) throw new PublicError('not_found', OP);
    return row;
  };
  const readOperation = (row: OperationRow): ProjectDeleteOperation => {
    const manifest = row.manifest_json === null ? null : JSON.parse(row.manifest_json) as ProjectDeleteManifest;
    if (manifest !== null && hash(manifest) !== row.manifest_digest) conflict('manifest_corrupt');
    return {
      operationId: row.id, projectId: row.target_project_id, status: row.status, owner: row.owner_id, fence: row.fence,
      manifestDigest: row.manifest_digest, manifest, failedStep: row.failed_step,
      steps: db.prepare('SELECT step, status, evidence_digest AS evidenceDigest FROM project_delete_steps WHERE operation_id = ? ORDER BY step').all(row.id) as ProjectDeleteOperation['steps'],
    };
  };
  const owned = (identity: ProjectDeleteExecutorIdentity): OperationRow => {
    const row = readRow(identity.operationId);
    if (!identity.owner || !Number.isSafeInteger(identity.fence) || row.owner_id !== identity.owner || row.fence !== identity.fence || row.status === 'completed') conflict('stale_executor');
    const gate = db.prepare("SELECT 1 FROM maintenance_occupancy WHERE id = 'global' AND state = 'held' AND operation = 'project_delete' AND operation_id = ? AND owner_id = ? AND fence = ?")
      .get(row.id, row.owner_id, row.fence);
    if (!gate) conflict('stale_maintenance_owner');
    return row;
  };
  const replay = (principal: TrustedPrincipal, commandId: string, digest: string): CommandReceipt | undefined => {
    assertTrustedPrincipal(principal);
    const existing = receipts.findReceiptByCommandId(principal.principalId, commandId);
    if (existing) authorizeCommandReplay(principal, existing, existing.scope.kind === 'project' ? existing.scope.projectId : null, OP);
    const decision = decideCommandReplay(existing, digest, OP);
    return decision.kind === 'replay' ? decision.receipt : undefined;
  };
  const store: ProjectDeleteStore = {
    findReceipt: (principal, commandId, digest) => session.transactWrite(`${OP}.replay`, () => replay(principal, commandId, digest)),
    accept(principal, envelope, digest, inventory) {
      return session.transactWrite(OP, () => {
        assertTrustedPrincipal(principal);
        authorizeCommand(principal, envelope);
        const prior = replay(principal, envelope.commandId, digest);
        if (prior) return prior;
        if (envelope.operation !== OP || envelope.scope.kind !== 'project' || computeCommandRequestDigest(envelope) !== digest) conflict('invalid_command_binding');
        const projectId = envelope.scope.projectId;
        authorize(principal, projectId);
        const timestamp = now();
        if (evaluateCommandTiming(envelope, timestamp).kind !== 'fresh') throw new PublicError('command_expired', OP);
        const expiry = Number(envelope.payload.expiresAtUtcMs);
        if (!(timestamp < expiry) || inventory.projectId !== projectId
          || inventory.projectStatus !== 'archived' || inventory.projectRevision !== envelope.expectedRevision
          || !inventory.complete || hasProjectArchiveBlockers(inventory.activity)
          || inventory.references.incomingCrossProject > 0 || inventory.references.unknown > 0
          || computeProjectDeletePreviewDigest(inventory, PROJECT_DELETE_POLICY, expiry) !== envelope.payload.previewDigest) conflict('preview_content_changed');
        if (inventory.databaseDigest !== computeProjectDeleteDatabaseDigest(db, projectId)) conflict('database_snapshot_changed');
        const closeout = readProjectArchiveCloseoutInDatabase(db, projectId);
        if (closeout.status !== 'archived' || !closeout.clear) conflict('active_execution');
        assertNoUncertainWriters(db, projectId);
        options.maintenanceGate?.assertCanWrite('cleanup');
        const occupancy = db.prepare("SELECT state, fence FROM maintenance_occupancy WHERE id = 'global'").get() as { state: string; fence: number };
        if (occupancy?.state !== 'idle') throw new PublicError('resource_busy', OP);
        const operationId = randomUUID();
        const owner = `pending-${operationId}`;
        const fence = occupancy.fence + 1;
        const receipt = createAcceptedReceipt({ principalId: principal.principalId, commandId: envelope.commandId, operation: OP,
          scope: envelope.scope, requestDigest: digest, issuedAt: envelope.issuedAt, completedAt: new Date(timestamp).toISOString(), operationId });
        createSqliteStateAccess(session, { nowUtcMs: now }).transitionProjectStatusInTransaction({
          operation: 'delete', projectId, expectedRevision: envelope.expectedRevision,
        }, timestamp);
        const manifest: ProjectDeleteManifest = { inventory, objects: inventory.objects, retained: inventory.retained,
          databaseDigestAfterAccept: computeProjectDeleteDatabaseDigest(db, projectId) };
        db.prepare(`INSERT INTO project_delete_operations (id, target_project_id, principal_id, command_id, request_digest, status, owner_id, fence, manifest_digest, manifest_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'intent', ?, ?, ?, ?, ?, ?)`)
          .run(operationId, projectId, principal.principalId, envelope.commandId, digest, owner, fence, hash(manifest), JSON.stringify(manifest), timestamp, timestamp);
        db.prepare('INSERT INTO project_delete_receipts (principal_id, command_id, target_project_id, receipt_json) VALUES (?, ?, ?, ?)')
          .run(principal.principalId, envelope.commandId, projectId, JSON.stringify(receipt));
        for (const step of PROJECT_DELETE_STEPS) db.prepare('INSERT INTO project_delete_steps (operation_id, step) VALUES (?, ?)').run(operationId, step);
        db.prepare("UPDATE maintenance_occupancy SET state = 'held', operation = 'project_delete', operation_id = ?, owner_id = ?, host_instance_id = 'project-delete', fence = ?, acquired_at = ?, revision = revision + 1 WHERE id = 'global'")
          .run(operationId, owner, fence, timestamp);
        return receipt;
      });
    },
    get(principal, operationId) {
      assertTrustedPrincipal(principal);
      const row = readRow(operationId);
      authorize(principal, row.target_project_id);
      if (row.principal_id !== principal.principalId) throw new PublicError('forbidden', OP);
      return readOperation(row);
    },
    claim(principal, operationId, owner, expectedFence, previousExecutorStopped) {
      return session.transactWrite(`${OP}.claim`, () => {
        const operation = store.get(principal, operationId);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner)) throw new TypeError('非法删除执行者');
        owned({ operationId, owner: operation.owner!, fence: expectedFence });
        if (operation.status !== 'intent' && !previousExecutorStopped) conflict('previous_executor_stop_unconfirmed');
        const fence = operation.fence + 1;
        db.prepare("UPDATE project_delete_operations SET status = 'running', owner_id = ?, fence = ?, updated_at = ? WHERE id = ?")
          .run(owner, fence, now(), operationId);
        db.prepare("UPDATE maintenance_occupancy SET owner_id = ?, fence = ?, revision = revision + 1 WHERE id = 'global'").run(owner, fence);
        return readOperation(readRow(operationId));
      });
    },
    recordStep(identity, step, status, evidenceDigest) {
      session.transactWrite(`${OP}.step`, () => {
        const row = owned(identity);
        if (!PROJECT_DELETE_STEPS.includes(step) || !['completed', 'failed'].includes(status) || !/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new TypeError('非法删除步骤证据');
        const prior = db.prepare('SELECT status, evidence_digest FROM project_delete_steps WHERE operation_id = ? AND step = ?').get(row.id, step) as { status: string; evidence_digest: string };
        if (prior.status === 'completed') {
          if (status === 'completed' && prior.evidence_digest === evidenceDigest) return;
          conflict('step_already_completed');
        }
        db.prepare('UPDATE project_delete_steps SET status = ?, evidence_digest = ? WHERE operation_id = ? AND step = ?').run(status, evidenceDigest, row.id, step);
        db.prepare('UPDATE project_delete_operations SET status = ?, failed_step = ?, updated_at = ? WHERE id = ?')
          .run(status === 'failed' ? 'failed' : 'running', status === 'failed' ? step : null, now(), row.id);
      });
    },
    async finish(identity, verifyExternal) {
      const before = session.transactWrite(`${OP}.finish.preflight`, () => readOperation(owned(identity)));
      if (before.steps.length !== PROJECT_DELETE_STEPS.length || before.steps.some(step => step.status !== 'completed')) conflict('external_steps_incomplete');
      let failureStep = 'external_verification';
      try {
        if (!await verifyExternal(before)) conflict('external_cleanup_unverified');
        failureStep = 'database';
        return session.transactWrite(`${OP}.purge`, () => {
          const row = owned(identity);
          const current = readOperation(row);
          if (JSON.stringify(current) !== JSON.stringify(before)) conflict('operation_changed_during_verification');
          if (!current.manifest || current.manifest.databaseDigestAfterAccept !== computeProjectDeleteDatabaseDigest(db, row.target_project_id)) conflict('database_snapshot_changed');
          if (!readProjectArchiveCloseoutInDatabase(db, row.target_project_id).clear) conflict('active_execution');
          assertNoUncertainWriters(db, row.target_project_id);
          db.prepare("UPDATE project_delete_operations SET status = 'purging' WHERE id = ?").run(row.id);
          // Preserve authorization and retry identity, never result/error business bodies.
          const receiptRows = db.prepare(`SELECT principal_id, command_id FROM command_receipts WHERE ${projectDeleteOwnershipPredicate('command_receipts')}`).all(row.target_project_id) as { principal_id: string; command_id: string }[];
          for (const key of receiptRows) {
            const original = receipts.findReceiptByCommandId(key.principal_id, key.command_id)!;
            const minimal = original.status === 'completed' ? { ...original, result: original.scope.kind === 'registration'
              ? { projectDeleted: true, project: { id: row.target_project_id } } : { projectDeleted: true } }
              : original.status === 'rejected' ? { ...original, error: { code: original.error.code, message: 'Project management data deleted' } } : original;
            db.prepare('INSERT INTO project_delete_receipts (principal_id, command_id, target_project_id, result_ref, receipt_json) VALUES (?, ?, ?, ?, ?)')
              .run(key.principal_id, key.command_id, row.target_project_id, original.status === 'completed' ? original.resultRef : null, JSON.stringify(minimal));
          }
          db.pragma('defer_foreign_keys = ON');
          for (const table of deletionOrder(db)) {
            const predicate = table === 'projects' ? 'id = ?' : table === 'verification_processes'
              ? 'batch_id IN (SELECT id FROM verification_batches WHERE project_id = ?)' : projectDeleteOwnershipPredicate(table);
            db.prepare(`DELETE FROM ${quote(table)} WHERE ${predicate}`).run(row.target_project_id);
          }
          if ((db.pragma('foreign_key_check') as unknown[]).length !== 0) conflict('remaining_foreign_key_reference');
          db.prepare("UPDATE project_delete_operations SET status = 'completed', manifest_json = NULL, failed_step = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
          db.prepare("UPDATE maintenance_occupancy SET state = 'idle', operation = NULL, operation_id = NULL, owner_id = NULL, host_instance_id = NULL, acquired_at = NULL, blocked_reason = NULL, revision = revision + 1 WHERE id = 'global'").run();
          return readOperation(readRow(row.id));
        });
      } catch (error) {
        // The purge transaction rolled back completely. Keep file progress and the
        // maintenance fence; diagnosis is a separate short write, never completion.
        session.transactWrite(`${OP}.purge.failed`, () => {
          owned(identity);
          db.prepare("UPDATE project_delete_operations SET status = 'failed', failed_step = ?, updated_at = ? WHERE id = ?").run(failureStep, now(), identity.operationId);
        });
        throw error;
      }
    },
  };
  return store;
}
