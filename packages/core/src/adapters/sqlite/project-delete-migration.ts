/** Append-only v56. Retention guards still reject ordinary deletes. */
const retained = [
  ['batch_budget_revisions_immutable_delete', 'batch_budget_revisions'],
  ['run_outcome_settlements_immutable_delete', 'run_outcome_settlements'],
  ['task_claim_receipts_immutable_delete', 'task_claim_receipts'],
  ['attempt_notifications_immutable_delete', 'attempt_notifications'],
  ['attempt_diagnostics_immutable_delete', 'attempt_notification_diagnostics'],
  ['execution_batch_members_immutable_delete', 'execution_batch_members'],
  ['integration_predecessor_snapshots_immutable_delete', 'integration_predecessor_snapshots'],
  ['git_integration_commands_retained', 'git_integration_commands'],
  ['git_integration_observations_retained', 'git_integration_observations'],
  ['git_agent_repair_retained', 'git_agent_repairs'],
  ['git_agent_repair_command_retained', 'git_agent_repair_commands'],
  ['git_agent_repair_attempt_retained', 'git_agent_repair_attempts'],
  ['phase_delivery_candidates_retained', 'phase_delivery_candidates'],
  ['phase_delivery_approvals_retained', 'phase_delivery_approvals'],
  ['project_profiles_immutable_delete', 'project_profiles'],
  ['capability_modules_immutable_delete', 'capability_modules'],
  ['document_versions_retained', 'document_versions'],
  ['repository_binding_snapshots_immutable_delete', 'repository_binding_snapshots'],
  ['baseline_authorizations_immutable_delete', 'baseline_authorizations'],
  ['verification_processes_immutable_delete', 'verification_processes'],
] as const;

export const PROJECT_DELETE_MIGRATION_SQL = `
-- No FK to projects: operation and minimal receipts survive project removal.
CREATE TABLE project_delete_operations (
  id TEXT PRIMARY KEY NOT NULL,
  target_project_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CONSTRAINT project_delete_operations_request_digest_check CHECK (length(request_digest) = 64),
  status TEXT NOT NULL CONSTRAINT project_delete_operations_status_check CHECK (status IN ('intent','running','failed','purging','completed')),
  owner_id TEXT,
  fence INTEGER NOT NULL DEFAULT 0 CONSTRAINT project_delete_operations_fence_check CHECK (typeof(fence) = 'integer' AND fence >= 0),
  manifest_digest TEXT NOT NULL CONSTRAINT project_delete_operations_manifest_digest_check CHECK (length(manifest_digest) = 64),
  manifest_json TEXT CONSTRAINT project_delete_operations_manifest_json_check CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
  failed_step TEXT CONSTRAINT project_delete_operations_failed_step_check CHECK (failed_step IS NULL OR failed_step IN ('artifact_bodies','artifact_staging','managed_worktrees','external_verification','database')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT project_delete_operations_manifest_shape_check CHECK ((status = 'completed' AND manifest_json IS NULL AND failed_step IS NULL) OR (status <> 'completed' AND manifest_json IS NOT NULL)),
  CONSTRAINT project_delete_operations_owner_shape_check CHECK ((fence = 0 AND owner_id IS NULL AND status = 'intent') OR (fence > 0 AND owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX project_delete_operations_principal_command_unique ON project_delete_operations(principal_id, command_id);
CREATE TABLE project_delete_steps (
  operation_id TEXT NOT NULL REFERENCES project_delete_operations(id) ON DELETE RESTRICT,
  step TEXT NOT NULL CONSTRAINT project_delete_steps_step_check CHECK (step IN ('artifact_bodies','artifact_staging','managed_worktrees')),
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT project_delete_steps_status_check CHECK (status IN ('pending','completed','failed')),
  evidence_digest TEXT CONSTRAINT project_delete_steps_evidence_digest_check CHECK (evidence_digest IS NULL OR length(evidence_digest) = 64),
  PRIMARY KEY (operation_id, step),
  CONSTRAINT project_delete_steps_evidence_shape_check CHECK ((status = 'pending' AND evidence_digest IS NULL) OR (status <> 'pending' AND evidence_digest IS NOT NULL))
);
CREATE TABLE project_delete_receipts (
  principal_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  target_project_id TEXT NOT NULL,
  result_ref TEXT UNIQUE,
  receipt_json TEXT NOT NULL CONSTRAINT project_delete_receipts_json_check CHECK (json_valid(receipt_json)),
  PRIMARY KEY (principal_id, command_id)
);
CREATE TRIGGER project_delete_identity_immutable BEFORE UPDATE ON project_delete_operations
WHEN NEW.id IS NOT OLD.id OR NEW.target_project_id IS NOT OLD.target_project_id
  OR NEW.principal_id IS NOT OLD.principal_id OR NEW.command_id IS NOT OLD.command_id
  OR NEW.request_digest IS NOT OLD.request_digest OR NEW.manifest_digest IS NOT OLD.manifest_digest
  OR NEW.created_at IS NOT OLD.created_at OR NEW.fence < OLD.fence
  OR (NEW.status <> 'completed' AND NEW.manifest_json IS NOT OLD.manifest_json)
  OR OLD.status = 'completed'
BEGIN SELECT RAISE(ABORT, 'project delete identity/manifest/fence immutable'); END;
CREATE TRIGGER project_delete_retained BEFORE DELETE ON project_delete_operations
BEGIN SELECT RAISE(ABORT, 'project delete identity retained'); END;
CREATE TRIGGER project_delete_receipts_immutable BEFORE UPDATE ON project_delete_receipts
BEGIN SELECT RAISE(ABORT, 'minimal receipt immutable'); END;
CREATE TRIGGER project_delete_receipts_retained BEFORE DELETE ON project_delete_receipts
BEGIN SELECT RAISE(ABORT, 'minimal receipt retained'); END;
${retained.map(([trigger, table]) => `
DROP TRIGGER ${trigger};
CREATE TRIGGER ${trigger} BEFORE DELETE ON ${table}
WHEN NOT EXISTS (
  SELECT 1 FROM project_delete_operations o JOIN maintenance_occupancy m ON m.operation_id = o.id
  WHERE o.target_project_id = ${table === 'verification_processes' ? '(SELECT project_id FROM verification_batches WHERE id = OLD.batch_id)' : 'OLD.project_id'}
    AND o.status = 'purging' AND m.state = 'held' AND m.operation = 'project_delete'
    AND m.owner_id = o.owner_id AND m.fence = o.fence
)
BEGIN SELECT RAISE(ABORT, '${table} retained outside verified project deletion'); END;
`).join('')}
`;
