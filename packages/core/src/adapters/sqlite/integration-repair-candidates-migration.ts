export const INTEGRATION_REPAIR_CANDIDATES_MIGRATION_SQL = `
CREATE TABLE integration_repair_candidate_holds (
 project_id TEXT NOT NULL, repair_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('public_contract_break','requirements_tradeoff','high_risk_delete','out_of_scope',
 'identity_or_lock','budget_exhausted','invalid_runtime_output','stop_unconfirmed')),
 created_at INTEGER NOT NULL CHECK(created_at>=1),
 PRIMARY KEY(project_id,repair_id),
 FOREIGN KEY(project_id,repair_id) REFERENCES integration_repair_authorizations(project_id,repair_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,attempt_id) REFERENCES integration_repair_attempts(project_id,attempt_id) ON DELETE RESTRICT
);
CREATE TRIGGER integration_repair_candidate_holds_scope BEFORE INSERT ON integration_repair_candidate_holds
WHEN NOT EXISTS(SELECT 1 FROM integration_repair_attempts a WHERE a.project_id=NEW.project_id
 AND a.repair_id=NEW.repair_id AND a.attempt_id=NEW.attempt_id)
BEGIN SELECT RAISE(ABORT,'integration repair candidate hold scope mismatch'); END;
CREATE TRIGGER integration_repair_candidate_holds_immutable BEFORE UPDATE ON integration_repair_candidate_holds
BEGIN SELECT RAISE(ABORT,'integration repair candidate hold immutable'); END;
CREATE TRIGGER integration_repair_candidate_holds_retained BEFORE DELETE ON integration_repair_candidate_holds
BEGIN SELECT RAISE(ABORT,'integration repair candidate hold retained'); END;
`;
