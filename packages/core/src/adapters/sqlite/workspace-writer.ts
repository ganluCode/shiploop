import { StorageError } from '../../ports/errors.js';
import type { SqliteStorageSession } from './session.js';

/** The workspace keeps its original preparation identity; ordered operation events identify later writers. */
export function readCurrentWorkspaceWriter(session: SqliteStorageSession, projectId: string, workspaceId: string) {
  const db = session.database;
  const workspace = db.prepare(`SELECT project_id, feature_id, run_id, attempt_id, owner_id,
    host_instance_id, execution_version FROM managed_workspaces WHERE project_id = ? AND id = ?`)
    .get(projectId, workspaceId) as WriterRow | undefined;
  if (!workspace) return null;
  const event = db.prepare(`SELECT operation_id FROM state_events WHERE project_id = ?
    AND aggregate_id = ? AND event_type = 'workspace.operation_updated' ORDER BY sequence DESC LIMIT 1`)
    .get(projectId, workspace.feature_id) as { operation_id: string } | undefined;
  // Legacy workspaces without an operation journal retain their original writer.
  if (!event) return workspace;
  const operation = db.prepare(`SELECT project_id, feature_id, run_id, attempt_id, owner_id,
    host_instance_id, execution_version FROM workspace_operations WHERE project_id = ? AND workspace_id = ? AND id = ?`)
    .get(projectId, workspaceId, event.operation_id) as WriterRow | undefined;
  if (!operation || operation.feature_id !== workspace.feature_id) {
    throw new StorageError('corrupt', 'WorkRecovery.workspaceWriter', 'workspace writer journal is incomplete');
  }
  return operation;
}

interface WriterRow {
  project_id: string;
  feature_id: string;
  run_id: string;
  attempt_id: string;
  owner_id: string;
  host_instance_id: string;
  execution_version: number;
}
