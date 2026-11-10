export const INTEGRATION_REPAIR_ATTEMPTS_MIGRATION_SQL = `
CREATE TABLE integration_repair_attempts (
  project_id TEXT NOT NULL, attempt_id TEXT NOT NULL, repair_id TEXT NOT NULL, run_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, host_instance_id TEXT NOT NULL, execution_version INTEGER NOT NULL CHECK(execution_version>=1),
  request TEXT NOT NULL CHECK(json_valid(request) AND json_type(request)='object'),
  runtime_request TEXT CHECK(runtime_request IS NULL OR (json_valid(runtime_request) AND json_type(runtime_request)='object')),
  dispatch TEXT NOT NULL CHECK(json_valid(dispatch) AND json_type(dispatch)='object'),
  process_identity TEXT CHECK(process_identity IS NULL OR (json_valid(process_identity) AND json_type(process_identity)='object')),
  started_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, max_tokens INTEGER NOT NULL CHECK(max_tokens>=1), max_runtime_ms INTEGER NOT NULL CHECK(max_runtime_ms>=1),
  output TEXT CHECK(output IS NULL OR (json_valid(output) AND json_type(output)='object')),
  stopped_at INTEGER,
  PRIMARY KEY(project_id,attempt_id),
  FOREIGN KEY(project_id,repair_id) REFERENCES integration_repair_authorizations(project_id,repair_id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,operation_id) REFERENCES integration_execution_claims(project_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX integration_repair_attempts_repair_unique ON integration_repair_attempts(project_id,repair_id);
CREATE UNIQUE INDEX integration_repair_attempts_active_unique ON integration_repair_attempts(project_id,repair_id) WHERE stopped_at IS NULL;
CREATE TRIGGER integration_repair_attempts_scope BEFORE INSERT ON integration_repair_attempts
WHEN NOT EXISTS(SELECT 1 FROM integration_repair_authorizations a JOIN integration_execution_claims c
 ON c.project_id=a.project_id AND c.operation_id=a.operation_id
 JOIN run_dispatch_claims d ON d.project_id=a.project_id AND d.run_id=a.run_id
 JOIN execution_slot_claims s ON s.claim_id=d.id
 WHERE a.project_id=NEW.project_id AND a.repair_id=NEW.repair_id AND a.run_id=NEW.run_id AND a.operation_id=NEW.operation_id
 AND c.admission='owned' AND c.owner_id=NEW.owner_id AND d.owner_id=NEW.owner_id AND d.host_instance_id=NEW.host_instance_id
 AND d.state='held' AND s.state='held' AND s.run_id=NEW.run_id
 AND d.id=json_extract(NEW.dispatch,'$.claimId') AND d.claim_version=json_extract(NEW.dispatch,'$.claimVersion')
 AND s.id=json_extract(NEW.dispatch,'$.slotId'))
BEGIN SELECT RAISE(ABORT,'integration repair attempt ownership mismatch'); END;
CREATE TRIGGER integration_repair_attempts_identity BEFORE UPDATE ON integration_repair_attempts
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.repair_id IS NOT OLD.repair_id
 OR NEW.run_id IS NOT OLD.run_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.owner_id IS NOT OLD.owner_id
 OR NEW.host_instance_id IS NOT OLD.host_instance_id OR NEW.execution_version IS NOT OLD.execution_version
 OR NEW.request IS NOT OLD.request OR NEW.started_at IS NOT OLD.started_at OR NEW.deadline_at IS NOT OLD.deadline_at
 OR NEW.dispatch IS NOT OLD.dispatch
 OR (OLD.process_identity IS NOT NULL AND NEW.process_identity IS NOT OLD.process_identity)
 OR NEW.max_tokens IS NOT OLD.max_tokens OR NEW.max_runtime_ms IS NOT OLD.max_runtime_ms
 OR (OLD.runtime_request IS NOT NULL AND NEW.runtime_request IS NOT OLD.runtime_request)
 OR (OLD.output IS NOT NULL AND NEW.output IS NOT OLD.output) OR (OLD.stopped_at IS NOT NULL AND NEW.stopped_at IS NOT OLD.stopped_at)
BEGIN SELECT RAISE(ABORT,'integration repair attempt identity immutable'); END;
CREATE TRIGGER integration_repair_attempts_retained BEFORE DELETE ON integration_repair_attempts
BEGIN SELECT RAISE(ABORT,'integration repair attempt retained'); END;
CREATE TRIGGER integration_repair_resource_retained BEFORE UPDATE OF state ON feature_resource_leases
WHEN NEW.state='released' AND EXISTS(SELECT 1 FROM integration_repair_attempts a JOIN integration_execution_claims c
 ON c.project_id=a.project_id AND c.operation_id=a.operation_id
 WHERE a.project_id=OLD.project_id AND c.owner_id=OLD.owner_id AND c.owner_version=OLD.owner_version AND a.stopped_at IS NULL)
BEGIN SELECT RAISE(ABORT,'integration repair writer stop unconfirmed'); END;
CREATE TRIGGER integration_repair_dispatch_retained BEFORE UPDATE OF state ON run_dispatch_claims
WHEN NEW.state='released' AND EXISTS(SELECT 1 FROM integration_repair_attempts a
 WHERE a.project_id=OLD.project_id AND json_extract(a.dispatch,'$.claimId')=OLD.id AND a.stopped_at IS NULL)
BEGIN SELECT RAISE(ABORT,'integration repair writer stop unconfirmed'); END;
CREATE TRIGGER integration_repair_slot_retained BEFORE UPDATE OF state ON execution_slot_claims
WHEN NEW.state='released' AND EXISTS(SELECT 1 FROM integration_repair_attempts a
 WHERE a.project_id=OLD.project_id AND json_extract(a.dispatch,'$.slotId')=OLD.id AND a.stopped_at IS NULL)
BEGIN SELECT RAISE(ABORT,'integration repair writer stop unconfirmed'); END;
`;
