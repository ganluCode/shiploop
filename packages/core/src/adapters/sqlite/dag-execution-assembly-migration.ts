export const DAG_EXECUTION_ASSEMBLY_MIGRATION_SQL = `
CREATE TABLE run_execution_baselines (
  project_id TEXT NOT NULL, run_id TEXT NOT NULL, feature_id TEXT NOT NULL, batch_id TEXT NOT NULL,
  repository_binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
  repo_identity TEXT NOT NULL, base_commit TEXT NOT NULL CHECK(length(base_commit) IN (40,64) AND base_commit NOT GLOB '*[^0-9a-f]*'),
  integration_id TEXT NOT NULL, plan_revision INTEGER NOT NULL CHECK(plan_revision >= 1),
  authorization_digest TEXT NOT NULL CHECK(length(authorization_digest)=64 AND authorization_digest NOT GLOB '*[^0-9a-f]*'),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 1),
  PRIMARY KEY(project_id,run_id),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,integration_id) REFERENCES integration_plans(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,repository_binding_id) REFERENCES repository_bindings(project_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER run_execution_baselines_scope BEFORE INSERT ON run_execution_baselines
WHEN NOT EXISTS (SELECT 1 FROM runs r JOIN execution_batch_members m ON m.batch_id=r.batch_id AND m.feature_id=r.feature_id
  WHERE r.project_id=NEW.project_id AND r.id=NEW.run_id AND r.feature_id=NEW.feature_id AND r.batch_id=NEW.batch_id
    AND json_extract(r.input_snapshot,'$.integrationAuthorization.authorizationDigest')=NEW.authorization_digest)
  OR EXISTS(SELECT 1 FROM attempts WHERE project_id=NEW.project_id AND run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'run baseline requires authorized unstarted member'); END;
CREATE TRIGGER run_execution_baselines_immutable BEFORE UPDATE ON run_execution_baselines
BEGIN SELECT RAISE(ABORT,'run execution baseline immutable'); END;
CREATE TRIGGER run_execution_baselines_retained BEFORE DELETE ON run_execution_baselines
BEGIN SELECT RAISE(ABORT,'run execution baseline retained'); END;

CREATE TABLE integration_execution_claims (
  project_id TEXT NOT NULL, operation_id TEXT NOT NULL, run_id TEXT NOT NULL, source_plan_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL CHECK(owner_version >= 1),
  intent TEXT NOT NULL CHECK(json_valid(intent) AND json_type(intent)='object'),
  admission TEXT NOT NULL CHECK(admission IN ('owned','quarantined','settled')),
  verification_started INTEGER NOT NULL DEFAULT 0 CHECK(verification_started IN (0,1)),
  verification_result TEXT CHECK(verification_result IS NULL OR (json_valid(verification_result) AND json_type(verification_result)='object')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1), reason TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 1),
  PRIMARY KEY(project_id,operation_id),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,source_plan_id) REFERENCES integration_plans(project_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX integration_execution_claims_run_unique ON integration_execution_claims(project_id,run_id);
CREATE TRIGGER integration_execution_claims_identity BEFORE UPDATE ON integration_execution_claims
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.run_id IS NOT OLD.run_id
  OR NEW.source_plan_id IS NOT OLD.source_plan_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.owner_version IS NOT OLD.owner_version
  OR NEW.intent IS NOT OLD.intent OR NEW.created_at IS NOT OLD.created_at
  OR NEW.verification_started < OLD.verification_started
  OR (OLD.verification_result IS NOT NULL AND NEW.verification_result IS NOT OLD.verification_result)
BEGIN SELECT RAISE(ABORT,'integration admission identity immutable'); END;
CREATE TRIGGER integration_execution_claims_retained BEFORE DELETE ON integration_execution_claims
BEGIN SELECT RAISE(ABORT,'integration admission retained'); END;

CREATE TABLE integration_processes (
  project_id TEXT NOT NULL, operation_id TEXT NOT NULL, launch_id TEXT NOT NULL,
  process_identity TEXT NOT NULL CHECK(json_valid(process_identity) AND json_type(process_identity)='object'),
  stopped INTEGER NOT NULL DEFAULT 0 CHECK(stopped IN (0,1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 1),
  PRIMARY KEY(project_id,operation_id,launch_id),
  FOREIGN KEY(project_id,operation_id) REFERENCES integration_execution_claims(project_id,operation_id) ON DELETE RESTRICT
);
CREATE TRIGGER integration_processes_identity BEFORE UPDATE ON integration_processes
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.launch_id IS NOT OLD.launch_id
  OR NEW.process_identity IS NOT OLD.process_identity OR NEW.created_at IS NOT OLD.created_at OR NEW.stopped < OLD.stopped
BEGIN SELECT RAISE(ABORT,'integration process identity immutable'); END;
CREATE TRIGGER integration_processes_retained BEFORE DELETE ON integration_processes
BEGIN SELECT RAISE(ABORT,'integration process retained'); END;
`;
