/** P07-3 / F-016 repair: retain immutable evidence wording for ordinary deletes. */
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

const projectIdExpression = (table: string) => table === 'verification_processes'
  ? '(SELECT project_id FROM verification_batches WHERE id = OLD.batch_id)'
  : 'OLD.project_id';

export const VERIFICATION_PROCESS_RETENTION_MESSAGE_MIGRATION_SQL = `
${retained.map(([trigger, table]) => `
DROP TRIGGER ${trigger};
CREATE TRIGGER ${trigger} BEFORE DELETE ON ${table}
WHEN NOT EXISTS (
  SELECT 1 FROM project_delete_operations o JOIN maintenance_occupancy m ON m.operation_id = o.id
  WHERE o.target_project_id = ${projectIdExpression(table)}
    AND o.status = 'purging' AND m.state = 'held' AND m.operation = 'project_delete'
    AND m.owner_id = o.owner_id AND m.fence = o.fence
)
BEGIN SELECT RAISE(ABORT, '${table} immutable; retained outside verified project deletion'); END;
`).join('')}
`;
