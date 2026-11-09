/** Freeze names without touching Git refs, workspace baselines or plan digests. */
export const GIT_NAMING_MIGRATION_SQL = `
ALTER TABLE features ADD COLUMN branch_name TEXT
  CONSTRAINT features_branch_name_check CHECK(branch_name IS NULL OR length(branch_name) BETWEEN 1 AND 255);
UPDATE features SET branch_name = coalesce(
  (SELECT w.branch FROM managed_workspaces w WHERE w.project_id=features.project_id AND w.feature_id=features.id),
  (SELECT 'feat/' || lower(replace(c.code,'-','/')) || '-feature'
    FROM entity_display_codes c WHERE c.project_id=features.project_id
      AND c.entity_kind='feature' AND c.entity_id=features.id)
);
CREATE UNIQUE INDEX features_project_branch_name_unique ON features(project_id,branch_name) WHERE branch_name IS NOT NULL;
CREATE TRIGGER features_branch_name_immutable BEFORE UPDATE OF branch_name ON features
  WHEN OLD.branch_name IS NOT NULL AND NEW.branch_name IS NOT OLD.branch_name BEGIN
  SELECT RAISE(ABORT,'feature branch name is immutable');
END;
`;
