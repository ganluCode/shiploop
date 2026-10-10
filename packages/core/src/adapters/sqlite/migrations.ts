/**
 * F-003 可版本控制的 SQLite 迁移（adapters 层）。
 *
 * 设计依据：core-design/03 §6（迁移记录版本与校验摘要）与 core-design/11 §9
 * （schema_migrations：version 唯一、checksum、applied_at）。
 *
 * 形态与不变量：
 * - 迁移 SQL 为自包含 DDL，作为模块常量内嵌（不读取外部文件、不引用源码 cwd 或
 *   开发机绝对路径），因此随构建产物 packages/core/dist/adapters/sqlite/migrations.js
 *   分发并可定位；表结构以 ./schema.ts 的 Drizzle Schema 为准，一致性由
 *   test/sqlite-schema-migrations.test.ts 经真实 pragma 交叉核对；
 * - 每个迁移携带唯一递增版本（自 1 起）与稳定校验摘要：checksum 为迁移 SQL 内容
 *   的 SHA-256 小写 hex（内容函数，跨机器/构建稳定，可用于篡改与漂移检测）；
 * - 迁移执行、schema_migrations 记录写入、高版本拒写与失败恢复由 F-005 实现；
 *   本模块只声明内容与身份，不在 import 时打开数据库或产生任何副作用。
 */
import { createHash } from 'node:crypto';

export interface SqliteMigration {
  /** 唯一递增的迁移版本（≥1），与 schema_migrations.version 一致。 */
  readonly version: number;
  /** 迁移 SQL 脚本全文（自包含 DDL，可整体 exec）。 */
  readonly sql: string;
  /** sql 内容的 SHA-256 小写 hex 校验摘要（稳定、可重算核对）。 */
  readonly checksum: string;
}

/** 首个基础迁移：仅建立 P01-2 存储闭环的六张表，不生成后续执行/Chat 等表。 */
const MIGRATION_001_SQL = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  description TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  repository_binding_id TEXT,
  CONSTRAINT projects_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT projects_display_name_not_empty_check CHECK (length(display_name) > 0),
  CONSTRAINT projects_status_enum_check CHECK (status IN ('active', 'archiving', 'archived', 'deleting')),
  CONSTRAINT projects_labels_json_array_check CHECK (json_valid(labels) AND json_type(labels) = 'array'),
  CONSTRAINT projects_repository_binding_fk FOREIGN KEY (repository_binding_id) REFERENCES repository_bindings (id) ON DELETE RESTRICT,
  CONSTRAINT projects_repository_binding_same_project_fk FOREIGN KEY (id, repository_binding_id) REFERENCES repository_bindings (project_id, id) ON DELETE RESTRICT
);

CREATE TABLE repository_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  canonical_path TEXT NOT NULL,
  git_common_dir TEXT,
  repo_identity TEXT NOT NULL,
  binding_revision INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT repository_bindings_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT repository_bindings_canonical_path_not_empty_check CHECK (length(canonical_path) > 0),
  CONSTRAINT repository_bindings_repo_identity_not_empty_check CHECK (length(repo_identity) > 0),
  CONSTRAINT repository_bindings_binding_revision_positive_check CHECK (binding_revision >= 1),
  CONSTRAINT repository_bindings_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX repository_bindings_canonical_path_unique ON repository_bindings (canonical_path);
CREATE UNIQUE INDEX repository_bindings_project_id_id_unique ON repository_bindings (project_id, id);

CREATE TABLE global_settings (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  CONSTRAINT global_settings_singleton_id_check CHECK (id = 'global'),
  CONSTRAINT global_settings_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT global_settings_schema_version_positive_check CHECK (schema_version >= 1),
  CONSTRAINT global_settings_payload_json_check CHECK (json_valid(payload))
);

CREATE TABLE project_settings (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  CONSTRAINT project_settings_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT project_settings_schema_version_positive_check CHECK (schema_version >= 1),
  CONSTRAINT project_settings_payload_json_check CHECK (json_valid(payload)),
  CONSTRAINT project_settings_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX project_settings_project_id_unique ON project_settings (project_id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  media_type TEXT NOT NULL,
  expected_hash TEXT NOT NULL,
  content_hash TEXT,
  size_bytes INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  storage_locator TEXT NOT NULL,
  failure_reason TEXT,
  CONSTRAINT artifacts_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT artifacts_kind_not_empty_check CHECK (length(kind) > 0),
  CONSTRAINT artifacts_status_enum_check CHECK (status IN ('pending', 'ready', 'failed')),
  CONSTRAINT artifacts_media_type_not_empty_check CHECK (length(media_type) > 0),
  CONSTRAINT artifacts_expected_hash_sha256_check CHECK (length(expected_hash) = 64 AND expected_hash NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT artifacts_content_hash_sha256_check CHECK (content_hash IS NULL OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT artifacts_size_bytes_non_negative_check CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT artifacts_version_positive_check CHECK (version >= 1),
  CONSTRAINT artifacts_locator_not_empty_check CHECK (length(storage_locator) > 0),
  CONSTRAINT artifacts_ready_identity_check CHECK (status <> 'ready' OR (content_hash IS NOT NULL AND size_bytes IS NOT NULL)),
  CONSTRAINT artifacts_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
);

CREATE INDEX artifacts_project_id_status_index ON artifacts (project_id, status);

CREATE TABLE schema_migrations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  CONSTRAINT schema_migrations_version_positive_check CHECK (version >= 1),
  CONSTRAINT schema_migrations_checksum_sha256_check CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*')
);

CREATE UNIQUE INDEX schema_migrations_version_unique ON schema_migrations (version);
`;

/**
 * 第二个迁移（P01-3 / F-006）：新增 state_events 审计切片。
 *
 * 只为已确认的业务状态变化（项目元数据更新等）提供持久、脱敏、可与实体写入同事务的
 * 审计记录；不建执行域表、不建通知投递表。列与约束同 ./schema.ts 的 stateEvents，
 * 一致性由 test/sqlite-schema-migrations.test.ts 经真实 pragma 交叉核对。
 */
const MIGRATION_002_SQL = `
CREATE TABLE state_events (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  project_id TEXT,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  CONSTRAINT state_events_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT state_events_sequence_positive_check CHECK (sequence >= 1),
  CONSTRAINT state_events_event_type_not_empty_check CHECK (length(event_type) > 0),
  CONSTRAINT state_events_aggregate_id_not_empty_check CHECK (length(aggregate_id) > 0),
  CONSTRAINT state_events_aggregate_revision_positive_check CHECK (aggregate_revision >= 1),
  CONSTRAINT state_events_payload_json_object_check CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  CONSTRAINT state_events_project_scope_check CHECK ((project_id IS NOT NULL) OR (aggregate_type = 'global_settings')),
  CONSTRAINT state_events_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX state_events_sequence_unique ON state_events (sequence);
`;

/**
 * 第三个迁移（P02-2 / F-006）：新增 command_receipts 幂等命令回执表。
 *
 * 契约依据：docs/p02-2-commands-events-contract.md §10（表设计冻结）与 §15.1
 * （project_id 可空 + scope CHECK 的显式偏离登记，与 v2 state_events 同一先例）。
 * 列与约束同 ./schema.ts 的 commandReceipts，一致性由
 * test/sqlite-schema-migrations.test.ts 经真实 pragma 交叉核对。
 *
 * 边界：不建 operations 表、不加 operation_id 列；本版本不持久化 accepted
 * （status CHECK 只允许 completed/rejected）；唯一约束以 CREATE UNIQUE INDEX
 * 落库（与 v1/v2 既有迁移同一表示，pragma index_list origin='c' 与 Drizzle
 * uniqueIndex 可交叉核对），语义与表级 UNIQUE 约束等价。
 */
const MIGRATION_003_SQL = `
CREATE TABLE command_receipts (
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
  result_json TEXT,
  result_ref TEXT,
  error_code TEXT,
  error_message TEXT,
  error_details TEXT,
  issued_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  CONSTRAINT command_receipts_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_scope_check CHECK ((scope_kind = 'project' AND project_id IS NOT NULL) OR (scope_kind IN ('registration','global') AND project_id IS NULL)),
  CONSTRAINT command_receipts_status_check CHECK (status IN ('completed','rejected')),
  CONSTRAINT command_receipts_completed_check CHECK (status <> 'completed' OR (result_json IS NOT NULL AND result_ref IS NOT NULL AND error_code IS NULL)),
  CONSTRAINT command_receipts_rejected_check CHECK (status <> 'rejected' OR (error_code IS NOT NULL AND result_json IS NULL)),
  CONSTRAINT command_receipts_digest_check CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*')
);

CREATE UNIQUE INDEX command_receipts_principal_command_unique ON command_receipts (principal_id, command_id);
CREATE UNIQUE INDEX command_receipts_result_ref_unique ON command_receipts (result_ref);
CREATE INDEX command_receipts_principal_project_index ON command_receipts (principal_id, project_id);
`;

/**
 * 第四个迁移（P02-3 / F-007）：基线作用域四表。
 *
 * 契约依据：docs/p02-3-onboarding-contract.md §10（表设计冻结）与 §15.8
 * （基线作用域表名与设计 11 通用验证表的关系，不提前建通用验证表）。
 *
 * 相对契约 §10 冻结 DDL 的 F-007 补充（已写回契约 §10 注记，均为加强约束、
 * 不改变冻结列集）：
 * - baseline_occupancy 新增 process_identity（JSON 对象可空）：记录可恢复的
 *   进程身份（pid/启动信息），供 F-013 重启后核对旧进程；语义与设计 11
 *   workspace_leases.process_identity 对齐（§15.8 字段对齐要求）；
 * - baseline_occupancy 新增单例 CHECK（id='global'）：与 global_settings 同一
 *   先例，保证全局单并发占用只有一行；
 * - 同项目复合外键（与 v1 projects↔repository_bindings 的 F-008 补齐同一先例）：
 *   baseline_authorizations(project_id, repository_binding_id) →
 *   repository_bindings(project_id, id)；baseline_operations(project_id,
 *   authorization_id) → baseline_authorizations(project_id, id)；
 *   baseline_check_results(project_id, operation_id) → baseline_operations
 *   (project_id, id)；另加 baseline_check_results.output_artifact_id →
 *   artifacts(id)（制品引用存在性）。直接 SQL 的跨项目引用在 DDL 级被拒绝。
 *
 * 列与约束同 ./schema.ts 的同名 Drizzle 表，一致性由
 * test/sqlite-schema-migrations.test.ts 经真实 pragma 交叉核对。
 * 不建 Work/Task/Attempt/Chat 或通用验证表（§2.2/§15.8）。
 */
const MIGRATION_004_SQL = `
CREATE TABLE baseline_authorizations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  repository_binding_id TEXT NOT NULL,
  head_commit TEXT,
  working_tree_digest TEXT NOT NULL,
  has_uncommitted_changes INTEGER NOT NULL,
  policy_revision TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  authorized_by TEXT NOT NULL,
  authorized_at INTEGER NOT NULL,
  CONSTRAINT baseline_authorizations_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_authorizations_binding_fk FOREIGN KEY (repository_binding_id) REFERENCES repository_bindings (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_authorizations_binding_same_project_fk FOREIGN KEY (project_id, repository_binding_id) REFERENCES repository_bindings (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT baseline_authorizations_digest_check CHECK (length(working_tree_digest) = 64 AND length(plan_digest) = 64),
  CONSTRAINT baseline_authorizations_plan_json_check CHECK (json_valid(plan_json))
);

CREATE UNIQUE INDEX baseline_authorizations_project_id_id_unique ON baseline_authorizations (project_id, id);

CREATE TABLE baseline_operations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  authorization_id TEXT,
  status TEXT NOT NULL,
  reason_code TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  CONSTRAINT baseline_operations_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_operations_authorization_fk FOREIGN KEY (authorization_id) REFERENCES baseline_authorizations (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_operations_authorization_same_project_fk FOREIGN KEY (project_id, authorization_id) REFERENCES baseline_authorizations (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT baseline_operations_status_check CHECK (
    status IN ('accepted','running','cancelling','completed','cancelled','failed','interrupted','not_run')
  )
);

CREATE INDEX baseline_operations_project_index ON baseline_operations (project_id, id);
CREATE UNIQUE INDEX baseline_operations_project_id_id_unique ON baseline_operations (project_id, id);

CREATE TABLE baseline_check_results (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  check_key TEXT NOT NULL,
  argv_json TEXT NOT NULL,
  cwd_ref TEXT,
  environment_ref TEXT,
  timeout_ms INTEGER NOT NULL,
  required INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER NOT NULL DEFAULT 0,
  output_artifact_id TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  CONSTRAINT baseline_check_results_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_check_results_operation_fk FOREIGN KEY (operation_id) REFERENCES baseline_operations (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_check_results_operation_same_project_fk FOREIGN KEY (project_id, operation_id) REFERENCES baseline_operations (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT baseline_check_results_output_artifact_fk FOREIGN KEY (output_artifact_id) REFERENCES artifacts (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_check_results_status_check CHECK (
    status IN ('passed','failed','error','inconclusive','not_run')
  ),
  CONSTRAINT baseline_check_results_argv_json_check CHECK (json_valid(argv_json) AND json_type(argv_json) = 'array'),
  CONSTRAINT baseline_check_results_timeout_positive_check CHECK (timeout_ms >= 1),
  CONSTRAINT baseline_check_results_revision_positive_check CHECK (revision >= 1)
);

CREATE UNIQUE INDEX baseline_check_results_operation_check_unique ON baseline_check_results (operation_id, check_key);

CREATE TABLE baseline_occupancy (
  id TEXT PRIMARY KEY NOT NULL,
  holder_operation_id TEXT,
  acquired_at INTEGER,
  heartbeat_at INTEGER,
  process_identity TEXT,
  CONSTRAINT baseline_occupancy_singleton_id_check CHECK (id = 'global'),
  CONSTRAINT baseline_occupancy_holder_fk FOREIGN KEY (holder_operation_id) REFERENCES baseline_operations (id) ON DELETE RESTRICT,
  CONSTRAINT baseline_occupancy_process_identity_json_check CHECK (process_identity IS NULL OR (json_valid(process_identity) AND json_type(process_identity) = 'object'))
);
`;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 已声明的全部 SQLite 迁移，按版本升序；F-005 的执行器按此顺序应用并核对摘要。 */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    sql: MIGRATION_001_SQL,
    checksum: sha256Hex(MIGRATION_001_SQL),
  },
  {
    version: 2,
    sql: MIGRATION_002_SQL,
    checksum: sha256Hex(MIGRATION_002_SQL),
  },
  {
    version: 3,
    sql: MIGRATION_003_SQL,
    checksum: sha256Hex(MIGRATION_003_SQL),
  },
  {
    version: 4,
    sql: MIGRATION_004_SQL,
    checksum: sha256Hex(MIGRATION_004_SQL),
  },
];
