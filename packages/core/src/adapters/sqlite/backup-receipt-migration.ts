/**
 * P07-3 / F-014（迁移 v59）：data.backup.create 接受回执（receipt-only v8）。
 *
 * - 新增可空列 backup_id（owner 选择的备份身份；仅 v8 accepted 行非 NULL）；
 * - command_receipts_association_check 增加 v8 分支：operation='data.backup.create'、
 *   status='accepted'、global scope、无 Batch/Run/planning 关联列；
 * - 表重建沿用 v36 同一纪律（CREATE new → INSERT SELECT → DROP → RENAME →
 *   重建索引）；v5 生成列 baseline_operation_id 及既有外键不变。
 */
export const BACKUP_RECEIPT_MIGRATION_SQL = `
CREATE TABLE command_receipts_v59 (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  project_id TEXT,
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  operation_id TEXT,
  receipt_version INTEGER NOT NULL DEFAULT 5,
  baseline_operation_id TEXT GENERATED ALWAYS AS (CASE WHEN receipt_version = 5 THEN operation_id END) STORED,
  batch_id TEXT,
  run_id TEXT,
  planning_task_id TEXT,
  candidate_id TEXT,
  backup_id TEXT,
  result_json TEXT,
  result_ref TEXT,
  error_code TEXT,
  error_message TEXT,
  error_details TEXT,
  issued_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  CONSTRAINT command_receipts_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_operation_fk FOREIGN KEY (baseline_operation_id) REFERENCES baseline_operations (id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_baseline_same_project_fk FOREIGN KEY (project_id, baseline_operation_id) REFERENCES baseline_operations (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_work_batch_fk FOREIGN KEY (project_id, batch_id) REFERENCES execution_batches (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_work_run_fk FOREIGN KEY (project_id, batch_id, run_id) REFERENCES runs (project_id, batch_id, id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_planning_context_fk FOREIGN KEY (project_id, candidate_id) REFERENCES planning_contexts (project_id, candidate_id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_scope_check CHECK ((scope_kind = 'project' AND project_id IS NOT NULL) OR (scope_kind IN ('registration','global') AND project_id IS NULL)),
  CONSTRAINT command_receipts_status_check CHECK (status IN ('completed','rejected','accepted')),
  CONSTRAINT command_receipts_completed_check CHECK (status <> 'completed' OR (result_json IS NOT NULL AND result_ref IS NOT NULL AND error_code IS NULL)),
  CONSTRAINT command_receipts_rejected_check CHECK (status <> 'rejected' OR (error_code IS NOT NULL AND result_json IS NULL)),
  CONSTRAINT command_receipts_accepted_check CHECK (status <> 'accepted' OR (operation_id IS NOT NULL AND result_json IS NULL AND result_ref IS NULL AND error_code IS NULL)),
  CONSTRAINT command_receipts_association_check CHECK (
    (receipt_version = 5 AND batch_id IS NULL AND run_id IS NULL AND planning_task_id IS NULL AND candidate_id IS NULL AND backup_id IS NULL) OR
    (receipt_version = 6 AND operation = 'execution.start' AND status = 'accepted' AND scope_kind = 'project'
      AND batch_id IS NOT NULL AND run_id IS NOT NULL AND operation_id = batch_id
      AND planning_task_id IS NULL AND candidate_id IS NULL AND backup_id IS NULL
      AND error_message IS NULL AND error_details IS NULL) OR
    (receipt_version = 7 AND operation = 'planning.start' AND status = 'accepted' AND scope_kind = 'project'
      AND batch_id IS NOT NULL AND run_id IS NOT NULL AND planning_task_id IS NOT NULL AND candidate_id IS NOT NULL
      AND operation_id = batch_id AND backup_id IS NULL AND error_message IS NULL AND error_details IS NULL) OR
    (receipt_version = 8 AND operation = 'data.backup.create' AND status = 'accepted' AND scope_kind = 'global'
      AND project_id IS NULL AND batch_id IS NULL AND run_id IS NULL AND planning_task_id IS NULL
      AND candidate_id IS NULL AND backup_id IS NOT NULL AND error_message IS NULL AND error_details IS NULL)
  ),
  CONSTRAINT command_receipts_digest_check CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*')
);

INSERT INTO command_receipts_v59 (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, operation_id, receipt_version, batch_id, run_id, planning_task_id, candidate_id, backup_id, result_json, result_ref, error_code, error_message, error_details, issued_at, completed_at)
SELECT id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, operation_id, receipt_version, batch_id, run_id, planning_task_id, candidate_id, NULL, result_json, result_ref, error_code, error_message, error_details, issued_at, completed_at FROM command_receipts;

DROP TABLE command_receipts;
ALTER TABLE command_receipts_v59 RENAME TO command_receipts;
CREATE UNIQUE INDEX command_receipts_principal_command_unique ON command_receipts (principal_id, command_id);
CREATE UNIQUE INDEX command_receipts_result_ref_unique ON command_receipts (result_ref);
CREATE UNIQUE INDEX command_receipts_operation_id_unique ON command_receipts (operation_id);
CREATE INDEX command_receipts_principal_project_index ON command_receipts (principal_id, project_id);
`;
