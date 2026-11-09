export const PRODUCTION_OPERATIONS_MIGRATION_SQL = `
CREATE TABLE feature_repair_attempts (
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
  strategy TEXT NOT NULL CHECK(json_valid(strategy)),
  input_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','running','completed','failed','uncertain','interrupted')),
  token_limit INTEGER NOT NULL CHECK(token_limit > 0),
  tokens_used INTEGER CHECK(tokens_used IS NULL OR tokens_used >= 0),
  deadline INTEGER NOT NULL,
  process_identity TEXT CHECK(process_identity IS NULL OR json_valid(process_identity)),
  result_ref TEXT,
  stop_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(stop_confirmed IN (0,1)),
  PRIMARY KEY(project_id,run_id,ordinal),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE RESTRICT
);
CREATE TABLE git_pushes (
  operation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  boundary TEXT NOT NULL CHECK(boundary IN ('task','feature')),
  remote TEXT NOT NULL,
  remote_digest TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE RESTRICT
);
${['feature_repair_attempts', 'git_pushes'].map(table => `
CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table}
WHEN NOT EXISTS (
  SELECT 1 FROM project_delete_operations o JOIN maintenance_occupancy m ON m.operation_id=o.id
  WHERE o.target_project_id=OLD.project_id AND o.status='purging' AND m.state='held'
    AND m.operation='project_delete' AND m.owner_id=o.owner_id AND m.fence=o.fence
)
BEGIN SELECT RAISE(ABORT, '${table} retained outside verified project deletion'); END;
`).join('')}
CREATE TRIGGER feature_repair_identity_immutable BEFORE UPDATE ON feature_repair_attempts
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.run_id IS NOT OLD.run_id
 OR NEW.ordinal IS NOT OLD.ordinal OR NEW.strategy IS NOT OLD.strategy OR NEW.input_digest IS NOT OLD.input_digest
 OR NEW.token_limit IS NOT OLD.token_limit OR NEW.deadline IS NOT OLD.deadline
 OR (OLD.process_identity IS NOT NULL AND NEW.process_identity IS NOT OLD.process_identity)
 OR (OLD.result_ref IS NOT NULL AND NEW.result_ref IS NOT OLD.result_ref)
 OR NEW.stop_confirmed < OLD.stop_confirmed
BEGIN SELECT RAISE(ABORT, 'feature repair identity immutable'); END;
CREATE TRIGGER git_push_identity_immutable BEFORE UPDATE ON git_pushes
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.project_id IS NOT OLD.project_id OR NEW.run_id IS NOT OLD.run_id
 OR NEW.boundary IS NOT OLD.boundary OR NEW.remote IS NOT OLD.remote OR NEW.remote_digest IS NOT OLD.remote_digest
 OR NEW.branch IS NOT OLD.branch OR NEW.commit_sha IS NOT OLD.commit_sha OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.status='succeeded' AND NEW.status <> 'succeeded')
BEGIN SELECT RAISE(ABORT, 'git push identity immutable'); END;
`;
