import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '../../ports/errors.js';
import type { GitIntegrationJournal } from '../../ports/git-integration-journal.js';
import { validateIntegrationObservation } from '../../ports/git-integration-observation.js';
import type { SqliteStorageSession } from './session.js';

/** Private append-only evidence; git_operations remains the only execution state machine. */
export function createSqliteGitIntegrationJournal(session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number } = {}): GitIntegrationJournal {
  const db = session.database;
  const now = options.nowUtcMs ?? Date.now;
  function active() {
    if (!db.inTransaction) throw new TypeError('Integration journal requires a CommandTransaction');
  }
  function fail(reason: string): never {
    throw new StorageError('conflict', 'GitIntegrationJournal', reason, { details: { reason } });
  }
  return {
    claim(tx, request, requestDigest) {
      active();
      const operation = tx.getGitOperation(request.projectId, request.operationId);
      if (operation.intent.integrationPlan == null) fail('not_integration');
      const previous = db.prepare('SELECT operation_id, request_digest FROM git_integration_commands WHERE project_id = ? AND command_id = ?')
        .get(request.projectId, request.commandId) as { operation_id: string; request_digest: string } | undefined;
      if (previous) {
        if (previous.operation_id !== request.operationId || previous.request_digest !== requestDigest) fail('idempotency_key_reuse');
        return;
      }
      db.prepare('INSERT INTO git_integration_commands (id, project_id, command_id, operation_id, request_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), request.projectId, request.commandId, request.operationId, requestDigest, now());
    },
    read(tx, projectId, operationId) {
      active();
      const operation = tx.getGitOperation(projectId, operationId);
      const row = db.prepare('SELECT observation FROM git_integration_observations WHERE project_id = ? AND operation_id = ? ORDER BY sequence DESC LIMIT 1')
        .get(projectId, operationId) as { observation: string } | undefined;
      if (!row) return null;
      try { return validateIntegrationObservation(JSON.parse(row.observation), operation.intent); }
      catch { throw new StorageError('corrupt', 'GitIntegrationJournal.read', 'Invalid integration observation'); }
    },
    append(tx, projectId, operationId, expectedRevision, observation) {
      active();
      const operation = tx.getGitOperation(projectId, operationId);
      if (operation.status !== 'pending' || operation.revision !== expectedRevision) fail('operation_fenced');
      const value = validateIntegrationObservation(observation, operation.intent);
      const previous = this.read(tx, projectId, operationId);
      if (previous !== null) {
        if (isDeepStrictEqual(previous, value)) return;
        if (previous.outcome !== 'merging' || value.steps.length < previous.steps.length
          || !isDeepStrictEqual(previous.steps, value.steps.slice(0, previous.steps.length))) fail('observation_conflict');
      }
      const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM git_integration_observations WHERE project_id = ? AND operation_id = ?')
        .get(projectId, operationId) as { next: number };
      db.prepare('INSERT INTO git_integration_observations (id, project_id, operation_id, sequence, operation_revision, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), projectId, operationId, row.next, expectedRevision, JSON.stringify(value), now());
    },
  };
}
