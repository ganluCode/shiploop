/** Append-only v57: per-step durable observations, separate from project business data. */
export const PROJECT_DELETE_CHECKPOINT_MIGRATION_SQL = `
ALTER TABLE project_delete_steps ADD COLUMN checkpoint_json TEXT NOT NULL DEFAULT '{}'
  CONSTRAINT project_delete_checkpoint_json_check CHECK (json_valid(checkpoint_json) AND json_type(checkpoint_json) = 'object');
ALTER TABLE project_delete_steps ADD COLUMN checkpoint_digest TEXT NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
  CONSTRAINT project_delete_checkpoint_digest_check CHECK (length(checkpoint_digest) = 64 AND checkpoint_digest NOT GLOB '*[^0-9a-f]*');
`;
