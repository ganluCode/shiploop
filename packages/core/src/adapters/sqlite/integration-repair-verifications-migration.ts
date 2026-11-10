export const INTEGRATION_REPAIR_VERIFICATIONS_MIGRATION_SQL = `
CREATE TABLE integration_repair_verifications (
 project_id TEXT NOT NULL, repair_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 artifact_id TEXT NOT NULL, artifact_ref TEXT NOT NULL CHECK(json_valid(artifact_ref) AND json_type(artifact_ref)='object'),
 plan_ref TEXT NOT NULL CHECK(json_valid(plan_ref) AND json_type(plan_ref)='object'),
 result_ref TEXT NOT NULL CHECK(json_valid(result_ref) AND json_type(result_ref)='object'),
 input_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status='passed'), created_at INTEGER NOT NULL CHECK(created_at>=1),
 PRIMARY KEY(project_id,repair_id),
 FOREIGN KEY(project_id,repair_id) REFERENCES integration_repair_authorizations(project_id,repair_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,attempt_id) REFERENCES integration_repair_attempts(project_id,attempt_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,artifact_id) REFERENCES artifacts(project_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER integration_repair_verifications_scope BEFORE INSERT ON integration_repair_verifications
WHEN NOT EXISTS(SELECT 1 FROM integration_repair_attempts a JOIN artifacts f ON f.project_id=a.project_id
 WHERE a.project_id=NEW.project_id AND a.repair_id=NEW.repair_id AND a.attempt_id=NEW.attempt_id
 AND a.stopped_at IS NOT NULL AND a.output IS NOT NULL AND f.project_id=NEW.project_id AND f.id=NEW.artifact_id AND f.status='ready')
BEGIN SELECT RAISE(ABORT,'integration repair verification requires stopped attempt and ready artifact'); END;
CREATE TRIGGER integration_repair_verifications_immutable BEFORE UPDATE ON integration_repair_verifications
BEGIN SELECT RAISE(ABORT,'integration repair verification immutable'); END;
CREATE TRIGGER integration_repair_verifications_retained BEFORE DELETE ON integration_repair_verifications
BEGIN SELECT RAISE(ABORT,'integration repair verification retained'); END;
`;
