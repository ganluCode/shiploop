/** P07-3 / F-013: durable bounded retention cleanup and rotation progress. */
export const RETENTION_CLEANUP_MIGRATION_SQL = `
CREATE TABLE retention_operations (
  id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  operation_kind TEXT NOT NULL DEFAULT 'cleanup',
  status TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  snapshot_revision TEXT NOT NULL,
  next_index INTEGER NOT NULL DEFAULT 0,
  items_examined INTEGER NOT NULL DEFAULT 0,
  items_deleted INTEGER NOT NULL DEFAULT 0,
  bytes_deleted INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT,
  CONSTRAINT retention_operations_status_check CHECK (status IN ('planned','running','paused','failed','completed','unknown')),
  CONSTRAINT retention_operations_kind_check CHECK (operation_kind = 'cleanup'),
  CONSTRAINT retention_operations_policy_digest_check CHECK (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT retention_operations_input_json_check CHECK (json_valid(input_json) AND json_type(input_json) = 'object'),
  CONSTRAINT retention_operations_result_json_check CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
  CONSTRAINT retention_operations_counts_check CHECK (next_index >= 0 AND items_examined >= 0 AND items_deleted >= 0 AND bytes_deleted >= 0)
);
CREATE TABLE retention_operation_items (
  operation_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  identity_json TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (operation_id, item_index),
  CONSTRAINT retention_operation_items_status_check CHECK (status IN ('pending','deleted','retained','isolated','skipped','failed')),
  CONSTRAINT retention_operation_items_identity_check CHECK (json_valid(identity_json) AND json_type(identity_json) = 'object'),
  CONSTRAINT retention_operation_items_counts_check CHECK (item_index >= 0 AND bytes >= 0)
);
CREATE INDEX retention_operation_items_object_index ON retention_operation_items(object_kind, object_id);
`;
