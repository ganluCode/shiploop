export const FEATURE_CLOSEOUT_MIGRATION_SQL = `
CREATE TABLE feature_closeouts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  input_digest TEXT NOT NULL CONSTRAINT feature_closeouts_digest_check CHECK(length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  stage TEXT NOT NULL CONSTRAINT feature_closeouts_stage_check CHECK(stage IN ('pending','verifying','verified','repairing','committing','completed','failed','blocked','reconcile_required')),
  revision INTEGER NOT NULL CONSTRAINT feature_closeouts_revision_check CHECK(revision >= 1),
  repair_count INTEGER NOT NULL CONSTRAINT feature_closeouts_repairs_check CHECK(repair_count >= 0),
  max_repairs INTEGER NOT NULL CONSTRAINT feature_closeouts_limit_check CHECK(max_repairs BETWEEN 0 AND 3 AND repair_count <= max_repairs),
  owner TEXT NOT NULL CONSTRAINT feature_closeouts_owner_check CHECK(length(owner) > 0),
  evidence_ref TEXT,
  reason TEXT,
  PRIMARY KEY(project_id, run_id),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,feature_id) REFERENCES features(project_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER feature_closeouts_identity_insert BEFORE INSERT ON feature_closeouts
WHEN NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id AND r.feature_id = NEW.feature_id)
BEGIN SELECT RAISE(ABORT, 'feature closeout ownership mismatch'); END;
CREATE TRIGGER feature_closeouts_identity_update BEFORE UPDATE ON feature_closeouts
WHEN NEW.project_id != OLD.project_id OR NEW.run_id != OLD.run_id OR NEW.feature_id != OLD.feature_id
  OR NEW.input_digest != OLD.input_digest OR NEW.owner != OLD.owner OR NEW.max_repairs != OLD.max_repairs
BEGIN SELECT RAISE(ABORT, 'feature closeout identity immutable'); END;
CREATE TRIGGER feature_closeouts_retained BEFORE DELETE ON feature_closeouts
WHEN NOT EXISTS (
  SELECT 1 FROM project_delete_operations o JOIN maintenance_occupancy m ON m.operation_id = o.id
  WHERE o.target_project_id = OLD.project_id AND o.status = 'purging' AND m.state = 'held'
    AND m.operation = 'project_delete' AND m.owner_id = o.owner_id AND m.fence = o.fence
)
BEGIN SELECT RAISE(ABORT, 'feature closeout retained outside verified project deletion'); END;
`;
