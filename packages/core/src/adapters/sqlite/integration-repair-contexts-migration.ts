export const INTEGRATION_REPAIR_CONTEXTS_MIGRATION_SQL = `
CREATE TABLE integration_repair_contexts (
  project_id TEXT NOT NULL, repair_id TEXT NOT NULL, authorization_digest TEXT NOT NULL CHECK(length(authorization_digest)=64),
  facts_digest TEXT NOT NULL CHECK(length(facts_digest)=64),
  artifact_id TEXT NOT NULL, artifact_ref TEXT NOT NULL CHECK(json_valid(artifact_ref) AND json_type(artifact_ref)='object'),
  created_at INTEGER NOT NULL CHECK(created_at>=1),
  PRIMARY KEY(project_id,repair_id),
  FOREIGN KEY(project_id,repair_id) REFERENCES integration_repair_authorizations(project_id,repair_id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,artifact_id) REFERENCES artifacts(project_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER integration_repair_contexts_scope BEFORE INSERT ON integration_repair_contexts
WHEN NOT EXISTS(SELECT 1 FROM integration_repair_authorizations a JOIN artifacts f ON f.project_id=a.project_id
 WHERE a.project_id=NEW.project_id AND a.repair_id=NEW.repair_id AND f.id=NEW.artifact_id AND f.status='ready'
 AND json_extract(a.request,'$.authorizationDigest')=NEW.authorization_digest
 AND json_extract(NEW.artifact_ref,'$.artifactId')=f.id AND json_extract(NEW.artifact_ref,'$.contentHash')=f.content_hash
 AND json_extract(NEW.artifact_ref,'$.projectId')=f.project_id)
 OR EXISTS(SELECT 1 FROM integration_repair_attempts WHERE project_id=NEW.project_id AND repair_id=NEW.repair_id)
BEGIN SELECT RAISE(ABORT,'integration repair context requires ready evidence before admission'); END;
CREATE TRIGGER integration_repair_contexts_immutable BEFORE UPDATE ON integration_repair_contexts
BEGIN SELECT RAISE(ABORT,'integration repair context immutable'); END;
CREATE TRIGGER integration_repair_contexts_retained BEFORE DELETE ON integration_repair_contexts
BEGIN SELECT RAISE(ABORT,'integration repair context retained'); END;
`;
