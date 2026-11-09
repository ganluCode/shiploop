/** Display aliases never replace UUIDs or participate in plan digests/CAS.
 * Retain aliases after plan replacement so a deleted Task number is never reused.
 */
export const ENTITY_DISPLAY_CODES_MIGRATION_SQL = `
CREATE TABLE entity_display_codes (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  entity_kind TEXT NOT NULL CONSTRAINT entity_display_codes_kind_check CHECK(entity_kind IN ('phase','feature','task')),
  entity_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CONSTRAINT entity_display_codes_ordinal_check CHECK(ordinal > 0),
  code TEXT NOT NULL
);
CREATE UNIQUE INDEX entity_display_codes_identity_unique ON entity_display_codes(project_id,entity_kind,entity_id);
CREATE UNIQUE INDEX entity_display_codes_ordinal_unique ON entity_display_codes(project_id,entity_kind,parent_id,ordinal);
CREATE UNIQUE INDEX entity_display_codes_code_unique ON entity_display_codes(project_id,code);

-- Stable creation order, including insertion order for equal timestamps; titles
-- and mutable DAG/list order are deliberately excluded from numbering.
INSERT INTO entity_display_codes(project_id,entity_kind,entity_id,parent_id,ordinal,code)
SELECT project_id,'phase',id,project_id,n,printf('P%02d',n) FROM (
  SELECT *,row_number() OVER(PARTITION BY project_id ORDER BY created_at,rowid) n FROM phases
);
INSERT INTO entity_display_codes(project_id,entity_kind,entity_id,parent_id,ordinal,code)
SELECT f.project_id,'feature',f.id,f.phase_id,f.n,p.code || printf('-F%02d',f.n) FROM (
  SELECT *,row_number() OVER(PARTITION BY project_id,phase_id ORDER BY created_at,rowid) n FROM features
) f JOIN entity_display_codes p ON p.project_id=f.project_id AND p.entity_kind='phase' AND p.entity_id=f.phase_id;
INSERT INTO entity_display_codes(project_id,entity_kind,entity_id,parent_id,ordinal,code)
SELECT t.project_id,'task',t.id,t.feature_id,t.n,f.code || printf('-T%03d',t.n) FROM (
  SELECT *,row_number() OVER(PARTITION BY project_id,feature_id ORDER BY created_at,rowid) n FROM tasks WHERE kind='coding'
) t JOIN entity_display_codes f ON f.project_id=t.project_id AND f.entity_kind='feature' AND f.entity_id=t.feature_id;

CREATE TRIGGER phase_display_code_insert AFTER INSERT ON phases BEGIN
  INSERT INTO entity_display_codes(project_id,entity_kind,entity_id,parent_id,ordinal,code)
  SELECT NEW.project_id,'phase',NEW.id,NEW.project_id,n,printf('P%02d',n)
  FROM (SELECT coalesce(max(ordinal),0)+1 n FROM entity_display_codes
    WHERE project_id=NEW.project_id AND entity_kind='phase' AND parent_id=NEW.project_id)
  WHERE NOT EXISTS(SELECT 1 FROM entity_display_codes WHERE project_id=NEW.project_id AND entity_kind='phase' AND entity_id=NEW.id);
END;
CREATE TRIGGER feature_display_code_insert AFTER INSERT ON features BEGIN
  INSERT INTO entity_display_codes(project_id,entity_kind,entity_id,parent_id,ordinal,code)
  SELECT NEW.project_id,'feature',NEW.id,NEW.phase_id,n,p.code || printf('-F%02d',n)
  FROM entity_display_codes p CROSS JOIN (SELECT coalesce(max(ordinal),0)+1 n FROM entity_display_codes
    WHERE project_id=NEW.project_id AND entity_kind='feature' AND parent_id=NEW.phase_id)
  WHERE p.project_id=NEW.project_id AND p.entity_kind='phase' AND p.entity_id=NEW.phase_id
    AND NOT EXISTS(SELECT 1 FROM entity_display_codes WHERE project_id=NEW.project_id AND entity_kind='feature' AND entity_id=NEW.id);
END;
CREATE TRIGGER task_display_code_insert AFTER INSERT ON tasks WHEN NEW.kind='coding' BEGIN
  INSERT INTO entity_display_codes(project_id,entity_kind,entity_id,parent_id,ordinal,code)
  SELECT NEW.project_id,'task',NEW.id,NEW.feature_id,n,f.code || printf('-T%03d',n)
  FROM entity_display_codes f CROSS JOIN (SELECT coalesce(max(ordinal),0)+1 n FROM entity_display_codes
    WHERE project_id=NEW.project_id AND entity_kind='task' AND parent_id=NEW.feature_id)
  WHERE f.project_id=NEW.project_id AND f.entity_kind='feature' AND f.entity_id=NEW.feature_id
    AND NOT EXISTS(SELECT 1 FROM entity_display_codes WHERE project_id=NEW.project_id AND entity_kind='task' AND entity_id=NEW.id);
END;
`;
