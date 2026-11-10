/** Authorization evidence only. Existing Run, integration claims and Git operations remain authoritative. */
export const INTEGRATION_REPAIR_AUTHORIZATION_MIGRATION_SQL = `
CREATE TABLE integration_repair_authorizations (
  project_id TEXT NOT NULL, repair_id TEXT NOT NULL, operation_id TEXT NOT NULL, run_id TEXT NOT NULL,
  command_id TEXT NOT NULL, command_digest TEXT NOT NULL CHECK(length(command_digest)=64),
  request TEXT NOT NULL CHECK(json_valid(request) AND json_type(request)='object'),
  fence TEXT NOT NULL CHECK(json_valid(fence) AND json_type(fence)='object'),
  receipt TEXT NOT NULL CHECK(json_valid(receipt) AND json_type(receipt)='object'),
  created_at INTEGER NOT NULL CHECK(created_at>=1),
  PRIMARY KEY(project_id,repair_id),
  FOREIGN KEY(project_id,operation_id) REFERENCES integration_execution_claims(project_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX integration_repair_authorizations_operation_unique ON integration_repair_authorizations(project_id,operation_id);
CREATE UNIQUE INDEX integration_repair_authorizations_command_unique ON integration_repair_authorizations(project_id,command_id);
CREATE TRIGGER integration_repair_authorizations_scope BEFORE INSERT ON integration_repair_authorizations
WHEN NOT EXISTS (SELECT 1 FROM integration_execution_claims c JOIN runs r ON r.project_id=c.project_id AND r.id=c.run_id
  WHERE c.project_id=NEW.project_id AND c.operation_id=NEW.operation_id AND c.run_id=NEW.run_id AND c.admission='owned'
    AND c.owner_id=json_extract(NEW.fence,'$.ownerId') AND c.owner_version=json_extract(NEW.fence,'$.ownerVersion')
    AND c.revision=json_extract(NEW.fence,'$.expectedRevision')
    AND r.purpose='execute' AND r.status='queued' AND r.started_at IS NULL
    AND json_type(r.input_snapshot,'$.integrationAuthorization')='object'
    AND json_extract(NEW.request,'$.projectId')=NEW.project_id
    AND json_extract(NEW.request,'$.repairId')=NEW.repair_id
    AND json_extract(NEW.request,'$.runId')=NEW.run_id
    AND json_extract(NEW.request,'$.source.operationId')=NEW.operation_id
    AND json_extract(NEW.request,'$.commandId')=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'integration repair requires owned pending member'); END;
CREATE TRIGGER integration_repair_authorizations_immutable BEFORE UPDATE ON integration_repair_authorizations
BEGIN SELECT RAISE(ABORT,'integration repair authorization immutable'); END;
CREATE TRIGGER integration_repair_authorizations_retained BEFORE DELETE ON integration_repair_authorizations
BEGIN SELECT RAISE(ABORT,'integration repair authorization retained'); END;
`;
