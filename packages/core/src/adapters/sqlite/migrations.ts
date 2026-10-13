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

/**
 * 第五个迁移（P02-3 / F-008）：command_receipts 表重建，持久化 accepted 回执。
 *
 * 契约依据：docs/p02-3-onboarding-contract.md §5.3（accepted 回执与操作行同一
 * 提交事务持久化，§15.6 首次启用）与 §10 的 F-008 写回注记（v4 冻结时不含
 * 本列；F-007 登记的张力由本迁移落定）。
 *
 * 变更（相对 v3 冻结 DDL，均为加强约束）：
 * - 新增 operation_id 列（可空；accepted 回执的同事务 baseline_operations
 *   行身份，FK ON DELETE RESTRICT + 唯一索引：一条 accepted 回执至多对应
 *   一个操作）；
 * - status CHECK 扩展 accepted；新增 accepted 交叉字段 CHECK（accepted 必须
 *   携带 operation_id 且不带 result/result_ref/error）。
 *
 * 既有行迁移：INSERT ... SELECT 原样保留（v3/v4 行无 accepted，operation_id
 *   置 NULL）；SQLite 不支持 ALTER 修改 CHECK，按标准十二步重建（新表→拷贝
 * →删旧→改名→重建索引）；无其他表引用 command_receipts，DROP 安全。
 */
const MIGRATION_005_SQL = `
CREATE TABLE command_receipts_v5 (
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
  result_json TEXT,
  result_ref TEXT,
  error_code TEXT,
  error_message TEXT,
  error_details TEXT,
  issued_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  CONSTRAINT command_receipts_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_operation_fk FOREIGN KEY (operation_id) REFERENCES baseline_operations (id) ON DELETE RESTRICT,
  CONSTRAINT command_receipts_scope_check CHECK ((scope_kind = 'project' AND project_id IS NOT NULL) OR (scope_kind IN ('registration','global') AND project_id IS NULL)),
  CONSTRAINT command_receipts_status_check CHECK (status IN ('completed','rejected','accepted')),
  CONSTRAINT command_receipts_completed_check CHECK (status <> 'completed' OR (result_json IS NOT NULL AND result_ref IS NOT NULL AND error_code IS NULL)),
  CONSTRAINT command_receipts_rejected_check CHECK (status <> 'rejected' OR (error_code IS NOT NULL AND result_json IS NULL)),
  CONSTRAINT command_receipts_accepted_check CHECK (status <> 'accepted' OR (operation_id IS NOT NULL AND result_json IS NULL AND result_ref IS NULL AND error_code IS NULL)),
  CONSTRAINT command_receipts_digest_check CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*')
);

INSERT INTO command_receipts_v5 (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, operation_id, result_json, result_ref, error_code, error_message, error_details, issued_at, completed_at)
SELECT id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, NULL, result_json, result_ref, error_code, error_message, error_details, issued_at, completed_at FROM command_receipts;

DROP TABLE command_receipts;

ALTER TABLE command_receipts_v5 RENAME TO command_receipts;

CREATE UNIQUE INDEX command_receipts_principal_command_unique ON command_receipts (principal_id, command_id);
CREATE UNIQUE INDEX command_receipts_result_ref_unique ON command_receipts (result_ref);
CREATE UNIQUE INDEX command_receipts_operation_id_unique ON command_receipts (operation_id);
CREATE INDEX command_receipts_principal_project_index ON command_receipts (principal_id, project_id);
`;

/**
 * 第六个迁移（P03-1 / F-002）：计划结构四表 phases/features/tasks/task_dependencies。
 *
 * 契约依据：docs/p03-1-plan-import-contract.md（§2 计划 payload 契约、§9.1 多引用形态
 * 由本迁移定案：requirements 以多值 JSON 数组 requirements_refs 存储，与 F-001 纯校验
 * 的多引用形态一致）与 core-design/11 §4（字段与约束）、02 §10（标题/描述/标签规则）。
 *
 * 边界（仅建立本项必需表）：不建 feature_dependencies（Feature DAG）、
 * execution_batches/runs/attempts（执行域）、approvals（审批域）或配置/计划版本表；
 * tasks 不提前加 kind/attempt_counter/code_attempts_used/execution_version 等执行域列，
 * 随对应功能迁移增加。
 *
 * 约束先例（与 v1/v4 同一表示）：
 * - 同项目复合外键：features(project_id,phase_id) → phases(project_id,id)、
 *   tasks(project_id,feature_id) → features(project_id,id)；task_dependencies 另有
 *   同 Feature 复合外键 (feature_id,task_id)/(feature_id,depends_on_id) →
 *   tasks(feature_id,id)——跨项目父级与跨 Feature 依赖在 DDL 级被拒绝；
 * - 自依赖：CHECK(task_id <> depends_on_id)；重复边：UNIQUE(feature_id,task_id,
 *   depends_on_id)；环检测不在 DDL 层（不可表达），由存储原语在事务内以 DFS 校验；
 * - 枚举/JSON/版本检查：status/plan_status/complexity 枚举 CHECK；labels/source_refs/
 *   requirements_refs 为 JSON 数组、acceptance/execution_config 为 JSON 对象；
 *   revision >= 1；plan_digest 可空但携带时必须 64 位小写 hex；config_source 非空
 *   （完整策略来源取值由 F-003 定案，不在 DDL 预冻结枚举）；
 * - 状态枚举取自设计 02/11 的完整生命周期（与 v1 projects 同一先例：先冻结枚举，
 *   状态迁移语义随对应功能实现）。
 */
const MIGRATION_006_SQL = `
CREATE TABLE phases (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  description TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  CONSTRAINT phases_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT phases_title_not_empty_check CHECK (length(title) > 0),
  CONSTRAINT phases_status_enum_check CHECK (status IN ('open', 'closed', 'archived')),
  CONSTRAINT phases_labels_json_array_check CHECK (json_valid(labels) AND json_type(labels) = 'array'),
  CONSTRAINT phases_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX phases_project_id_id_unique ON phases (project_id, id);

CREATE TABLE features (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  phase_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  plan_status TEXT NOT NULL DEFAULT 'draft',
  description TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]',
  plan_digest TEXT,
  CONSTRAINT features_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT features_title_not_empty_check CHECK (length(title) > 0),
  CONSTRAINT features_status_enum_check CHECK (
    status IN ('draft', 'ready', 'running', 'awaiting_approval', 'completed', 'partial', 'failed')
  ),
  CONSTRAINT features_plan_status_enum_check CHECK (plan_status IN ('draft', 'pending_approval', 'approved')),
  CONSTRAINT features_labels_json_array_check CHECK (json_valid(labels) AND json_type(labels) = 'array'),
  CONSTRAINT features_source_refs_json_array_check CHECK (json_valid(source_refs) AND json_type(source_refs) = 'array'),
  CONSTRAINT features_plan_digest_sha256_check CHECK (plan_digest IS NULL OR (length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT features_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT features_phase_fk FOREIGN KEY (phase_id) REFERENCES phases (id) ON DELETE RESTRICT,
  CONSTRAINT features_phase_same_project_fk FOREIGN KEY (project_id, phase_id) REFERENCES phases (project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX features_project_id_id_unique ON features (project_id, id);
CREATE INDEX features_phase_id_status_index ON features (phase_id, status);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  feature_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  complexity TEXT,
  description TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  acceptance TEXT NOT NULL,
  requirements_refs TEXT NOT NULL DEFAULT '[]',
  execution_config TEXT NOT NULL,
  config_source TEXT NOT NULL,
  config_source_key TEXT,
  CONSTRAINT tasks_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT tasks_title_not_empty_check CHECK (length(title) > 0),
  CONSTRAINT tasks_status_enum_check CHECK (status IN ('pending', 'running', 'passed', 'failed', 'skipped', 'cancelled')),
  CONSTRAINT tasks_complexity_enum_check CHECK (complexity IS NULL OR complexity IN ('low', 'medium', 'high')),
  CONSTRAINT tasks_labels_json_array_check CHECK (json_valid(labels) AND json_type(labels) = 'array'),
  CONSTRAINT tasks_acceptance_json_object_check CHECK (json_valid(acceptance) AND json_type(acceptance) = 'object'),
  CONSTRAINT tasks_requirements_refs_json_array_check CHECK (json_valid(requirements_refs) AND json_type(requirements_refs) = 'array'),
  CONSTRAINT tasks_execution_config_json_object_check CHECK (json_valid(execution_config) AND json_type(execution_config) = 'object'),
  CONSTRAINT tasks_config_source_not_empty_check CHECK (length(config_source) > 0),
  CONSTRAINT tasks_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT tasks_feature_fk FOREIGN KEY (feature_id) REFERENCES features (id) ON DELETE RESTRICT,
  CONSTRAINT tasks_feature_same_project_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX tasks_project_id_id_unique ON tasks (project_id, id);
CREATE UNIQUE INDEX tasks_feature_id_id_unique ON tasks (feature_id, id);
CREATE INDEX tasks_feature_id_status_index ON tasks (feature_id, status);

CREATE TABLE task_dependencies (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  CONSTRAINT task_dependencies_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT task_dependencies_no_self_dependency_check CHECK (task_id <> depends_on_id),
  CONSTRAINT task_dependencies_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT task_dependencies_feature_fk FOREIGN KEY (feature_id) REFERENCES features (id) ON DELETE RESTRICT,
  CONSTRAINT task_dependencies_feature_same_project_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_dependencies_task_fk FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE RESTRICT,
  CONSTRAINT task_dependencies_task_same_feature_fk FOREIGN KEY (feature_id, task_id) REFERENCES tasks (feature_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_dependencies_depends_on_fk FOREIGN KEY (depends_on_id) REFERENCES tasks (id) ON DELETE RESTRICT,
  CONSTRAINT task_dependencies_depends_on_same_feature_fk FOREIGN KEY (feature_id, depends_on_id) REFERENCES tasks (feature_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX task_dependencies_feature_edge_unique ON task_dependencies (feature_id, task_id, depends_on_id);
CREATE INDEX task_dependencies_feature_depends_on_index ON task_dependencies (feature_id, depends_on_id);
`;

/**
 * 第七个迁移（P03-2 / F-002）：计划批准/拒绝决策记录表 approvals。
 *
 * 契约依据：docs/p03-2-plan-approval-contract.md（本 Feature 契约文档）与
 * core-design/11 §7（approvals：subject_type/subject_id/subject_digest/status/
 * decision_actor/reason/decided_at；主体摘要变更使旧批准失效——按摘要绑定区分
 * 当前/历史决定，不改写旧行）；v6 冻结时登记的「approvals（审批域）」张力
 * 由本迁移落定。
 *
 * 边界：只建决策记录表，不建计划/配置历史版本表（PlanRevision/
 * configuration_revisions 均属 PRD 明确不建设范围，设计 11 §3/§5）；
 * P03-2 决策命令只插入已决定（approved/rejected）行，pending/superseded
 * 为设计完整枚举先冻结（与 v1 projects/v6 features 同一先例），不提前实现
 * pending→decided 两段流或 superseded 改写原语。
 *
 * 约束先例（与 v1/v4/v6 同一表示）：
 * - 同项目复合外键 approvals(project_id,subject_id) → features(project_id,id)
 *  ——subject_type='feature_plan' 时 subject_id 即 Feature 稳定 ID，跨项目
 *   主体在 DDL 级被拒绝；subject_type 枚举 CHECK 先冻结仅 'feature_plan'，
 *   后续审批对象类型随对应功能扩展迁移；
 * - 状态枚举 CHECK（pending/approved/rejected/superseded）与已决定形态 CHECK
 *   （approved/rejected 必须携带 decision_actor 与 decided_at；pending 不得
 *   携带）——「不把拒绝显示为已批准」在行级即有形态约束；
 * - UNIQUE(project_id,subject_type,subject_id,subject_digest)：同一主体同一
 *   摘要至多一条决策（两个竞争决定最多一个生效的 DDL 兜底；命令层以
 *   Feature 聚合 CAS 先行裁决）；CAS 纪律经 revision ≥1 与命令层条件 UPDATE
 *   保证（本版本决策行为 insert-only，无更新原语）；
 * - 摘要 64 位小写 hex CHECK（与 features.plan_digest 同一形态）。
 */
const MIGRATION_007_SQL = `
CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_actor TEXT,
  reason TEXT,
  decided_at INTEGER,
  CONSTRAINT approvals_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT approvals_subject_type_enum_check CHECK (subject_type = 'feature_plan'),
  CONSTRAINT approvals_subject_digest_sha256_check CHECK (length(subject_digest) = 64 AND subject_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT approvals_status_enum_check CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  CONSTRAINT approvals_decision_actor_not_empty_check CHECK (decision_actor IS NULL OR length(decision_actor) > 0),
  CONSTRAINT approvals_decided_shape_check CHECK (
    (status IN ('approved', 'rejected') AND decision_actor IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'pending' AND decision_actor IS NULL AND decided_at IS NULL)
    OR status = 'superseded'
  ),
  CONSTRAINT approvals_decided_at_non_negative_check CHECK (decided_at IS NULL OR decided_at >= 0),
  CONSTRAINT approvals_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT approvals_feature_same_project_fk FOREIGN KEY (project_id, subject_id) REFERENCES features (project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX approvals_subject_decision_unique ON approvals (project_id, subject_type, subject_id, subject_digest);
CREATE INDEX approvals_project_subject_index ON approvals (project_id, subject_id);
`;

/**
 * 第八个迁移（P03-2 / F-003）：approvals 决策记录绑定适用检查政策身份。
 *
 * 契约依据：docs/p03-2-plan-approval-verification-contract.md（本 Feature 契约
 * 文档）与 p03-plan-approval PRD 验收标准 2（需求或检查政策改动后不能用旧
 * 批准执行）；core-design/11 §7（approvals 只批准具体版本，主体摘要变更使旧
 * 批准失效）。v7 冻结时「检查政策身份未入摘要」由本迁移以**显式绑定核验值**
 * 落定（planDigest 计算不变，与 P03-1 摘要契约兼容）。
 *
 * 变更：
 * - approvals 新增 check_policy_digest 列（可空；64 位小写 hex CHECK）。v8 起
 *   决策命令恒写入当前适用检查政策内容摘要（由命令用例在同一写事务内从
 *   全局+项目当前配置合并计算）；v7 遗留行升级为 NULL——不等于任何当前
 *   身份，有效批准核验 fail-closed（需重新批准当前身份）；
 * - 唯一索引重建为 (project_id, subject_type, subject_id, subject_digest,
 *   check_policy_digest)：决策身份 = 计划摘要 + 检查政策摘要复合——检查政策
 *   变化后同一 planDigest 可重新批准当前身份（新行），旧行作为历史证据保留；
 *   SQLite 唯一索引中 NULL 互不相等，v7 遗留行不与新决策冲突。
 *
 * 边界：不建配置/计划历史版本表；不重建 approvals 表（既有行原样保留，
 * 只增列与重建索引）。
 */
const MIGRATION_008_SQL = `
ALTER TABLE approvals ADD COLUMN check_policy_digest TEXT CONSTRAINT approvals_check_policy_digest_sha256_check CHECK (check_policy_digest IS NULL OR (length(check_policy_digest) = 64 AND check_policy_digest NOT GLOB '*[^0-9a-f]*'));

DROP INDEX approvals_subject_decision_unique;
CREATE UNIQUE INDEX approvals_subject_decision_unique ON approvals (project_id, subject_type, subject_id, subject_digest, check_policy_digest);
`;

/**
 * 第九个迁移（P03-3 / F-002）：单 Feature 执行域三表 execution_batches/runs/
 * batch_budget_revisions（+不可变内容校验触发器）。
 *
 * 契约依据：core-design/11 §5（表字段与约束）、§10（条件唯一/不可变内容校验须有
 * 失败用例/常用索引/ON DELETE RESTRICT）与 02 §3/§8（Run/Batch 状态机：活动集 =
 * queued/running/pausing/paused/cancelling/interrupted，终态 = succeeded/failed/
 * cancelled）；docs/p03-3-execution-schema-contract.md（本 Feature 契约文档，含
 * 相对设计 11 的登记偏离）。
 *
 * 边界（仅建立本项必需持久数据）：不建完整 attempts/workspace_leases/sessions/
 * chat_turns/recording_manifests/通知表（随 P03-4+ 对应功能迁移），不建计划/配置
 * 业务版本表（设计 11 §3/§5 明确不建设）；state_events 不加 run_id/task_id/
 * attempt_id 列（随其关联表同迁移加入）。
 *
 * 约束先例（与 v1/v4/v6 同一表示）：
 * - 同项目/同归属复合外键：execution_batches(project_id,phase_id,feature_id) →
 *   features(project_id,phase_id,id)（跨项目引用拒绝且 batch 的 phase_id 必须是
 *   其 Feature 的真实 Phase，直接 SQL 伪造归属被拒）；runs(project_id,batch_id) →
 *   execution_batches(project_id,id)、runs(project_id,feature_id) →
 *   features(project_id,id)、runs(batch_id,feature_id) →
 *   execution_batches(id,feature_id)（Run 必须落在父 Batch 的单 Feature 范围内）；
 *   batch_budget_revisions(project_id,batch_id) → execution_batches(project_id,id)；
 *   全部 ON DELETE RESTRICT；
 * - 单 Feature 不可变范围：Batch 以 feature_id（NOT NULL）+ scope_snapshot 保存恰
 *   一个 Feature 的范围，CHECK 强制 scope_snapshot.featureIds 为恰含一个成员的 JSON
 *   数组；config_snapshot/input_snapshot 为 JSON 对象（完整结构校验在端口，DDL 为
 *   合法性底线）；
 * - 有限初始预算与累计计数：budget_snapshot（JSON 对象，形态由 ports/
 *   execution-budget 的 schemaVersion=1 契约校验）+ budget_revision(≥1) +
 *   deadline_at(≥1 绝对 UTC 毫秒)；runs_created/attempts_created/runtime_starts/
 *   no_progress_runs 非负（负计数在 DDL 级拒绝）；Run 上限 max_attempts_per_run/
 *   run_time_limit_ms 存于 Run 行（派发时冻结；精确范围归 ports 契约，DDL 只保正
 *   底线，避免把待确认的实施范围值冻结进不可变迁移）；
 * - 条件唯一（设计 11 §10）：同 Phase 有效活动 Batch 唯一、同 Feature 有效活动 Run
 *   唯一（部分唯一索引；活动集含 paused/interrupted——暂停与归属待核对不是可绕过的
 *   终态）；派发身份 UNIQUE(batch_id,work_key,dispatch_ordinal)；修订身份
 *   UNIQUE(batch_id,version)；
 * - 不可变内容（触发器 + 失败用例）：Batch 身份/范围/配置快照、Run 身份/输入快照/
 *   派发身份/Run 上限与时间依据（started_at 设定后不可改）UPDATE 拒绝；
 *   batch_budget_revisions 为初始与历史预算快照证据行，UPDATE/DELETE 一律拒绝
 *   ——当前预算在 Batch 行上正常演进时不覆盖任何历史版本。
 */
const MIGRATION_009_SQL = `
CREATE TABLE execution_batches (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  phase_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  scope_snapshot TEXT NOT NULL,
  config_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  budget_revision INTEGER NOT NULL DEFAULT 1,
  budget_snapshot TEXT NOT NULL,
  runs_created INTEGER NOT NULL DEFAULT 0,
  attempts_created INTEGER NOT NULL DEFAULT 0,
  runtime_starts INTEGER NOT NULL DEFAULT 0,
  no_progress_runs INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER NOT NULL,
  reason TEXT,
  CONSTRAINT execution_batches_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT execution_batches_status_enum_check CHECK (status IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted')),
  CONSTRAINT execution_batches_scope_snapshot_json_check CHECK (json_valid(scope_snapshot) AND json_type(scope_snapshot) = 'object'),
  CONSTRAINT execution_batches_scope_single_feature_check CHECK (json_type(scope_snapshot, '$.featureIds') IS 'array' AND json_array_length(scope_snapshot, '$.featureIds') = 1),
  CONSTRAINT execution_batches_config_snapshot_json_check CHECK (json_valid(config_snapshot) AND json_type(config_snapshot) = 'object'),
  CONSTRAINT execution_batches_budget_revision_positive_check CHECK (budget_revision >= 1),
  CONSTRAINT execution_batches_budget_snapshot_json_check CHECK (json_valid(budget_snapshot) AND json_type(budget_snapshot) = 'object'),
  CONSTRAINT execution_batches_runs_created_non_negative_check CHECK (runs_created >= 0),
  CONSTRAINT execution_batches_attempts_created_non_negative_check CHECK (attempts_created >= 0),
  CONSTRAINT execution_batches_runtime_starts_non_negative_check CHECK (runtime_starts >= 0),
  CONSTRAINT execution_batches_no_progress_runs_non_negative_check CHECK (no_progress_runs >= 0),
  CONSTRAINT execution_batches_deadline_at_positive_check CHECK (deadline_at >= 1),
  CONSTRAINT execution_batches_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT execution_batches_phase_fk FOREIGN KEY (phase_id) REFERENCES phases (id) ON DELETE RESTRICT,
  CONSTRAINT execution_batches_feature_fk FOREIGN KEY (feature_id) REFERENCES features (id) ON DELETE RESTRICT,
  CONSTRAINT execution_batches_feature_phase_same_project_fk FOREIGN KEY (project_id, phase_id, feature_id) REFERENCES features (project_id, phase_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX execution_batches_project_id_id_unique ON execution_batches (project_id, id);
CREATE UNIQUE INDEX execution_batches_id_feature_id_unique ON execution_batches (id, feature_id);
CREATE UNIQUE INDEX execution_batches_active_phase_unique ON execution_batches (phase_id) WHERE status IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted');

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_snapshot TEXT NOT NULL,
  config_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  scope_digest TEXT NOT NULL,
  work_key TEXT NOT NULL,
  dispatch_ordinal INTEGER NOT NULL DEFAULT 1,
  max_attempts_per_run INTEGER NOT NULL,
  run_time_limit_ms INTEGER NOT NULL,
  attempts_created INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  CONSTRAINT runs_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT runs_purpose_not_empty_check CHECK (length(purpose) > 0),
  CONSTRAINT runs_input_snapshot_json_check CHECK (json_valid(input_snapshot) AND json_type(input_snapshot) = 'object'),
  CONSTRAINT runs_config_snapshot_json_check CHECK (json_valid(config_snapshot) AND json_type(config_snapshot) = 'object'),
  CONSTRAINT runs_status_enum_check CHECK (status IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted')),
  CONSTRAINT runs_scope_digest_sha256_check CHECK (length(scope_digest) = 64 AND scope_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT runs_work_key_not_empty_check CHECK (length(work_key) > 0),
  CONSTRAINT runs_dispatch_ordinal_positive_check CHECK (dispatch_ordinal >= 1),
  CONSTRAINT runs_max_attempts_per_run_positive_check CHECK (max_attempts_per_run >= 1),
  CONSTRAINT runs_run_time_limit_ms_positive_check CHECK (run_time_limit_ms >= 1),
  CONSTRAINT runs_attempts_created_non_negative_check CHECK (attempts_created >= 0),
  CONSTRAINT runs_started_at_non_negative_check CHECK (started_at IS NULL OR started_at >= 0),
  CONSTRAINT runs_ended_at_non_negative_check CHECK (ended_at IS NULL OR ended_at >= 0),
  CONSTRAINT runs_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT runs_batch_fk FOREIGN KEY (batch_id) REFERENCES execution_batches (id) ON DELETE RESTRICT,
  CONSTRAINT runs_feature_fk FOREIGN KEY (feature_id) REFERENCES features (id) ON DELETE RESTRICT,
  CONSTRAINT runs_batch_same_project_fk FOREIGN KEY (project_id, batch_id) REFERENCES execution_batches (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT runs_feature_same_project_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT runs_batch_feature_same_scope_fk FOREIGN KEY (batch_id, feature_id) REFERENCES execution_batches (id, feature_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX runs_dispatch_identity_unique ON runs (batch_id, work_key, dispatch_ordinal);
CREATE UNIQUE INDEX runs_active_feature_unique ON runs (feature_id) WHERE status IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted');
CREATE INDEX runs_batch_id_status_index ON runs (batch_id, status);

CREATE TABLE batch_budget_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  budget_snapshot TEXT NOT NULL,
  deadline_at INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  CONSTRAINT batch_budget_revisions_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT batch_budget_revisions_version_positive_check CHECK (version >= 1),
  CONSTRAINT batch_budget_revisions_budget_snapshot_json_check CHECK (json_valid(budget_snapshot) AND json_type(budget_snapshot) = 'object'),
  CONSTRAINT batch_budget_revisions_deadline_at_positive_check CHECK (deadline_at >= 1),
  CONSTRAINT batch_budget_revisions_approved_by_not_empty_check CHECK (length(approved_by) > 0),
  CONSTRAINT batch_budget_revisions_reason_not_empty_check CHECK (length(reason) > 0),
  CONSTRAINT batch_budget_revisions_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT batch_budget_revisions_batch_fk FOREIGN KEY (batch_id) REFERENCES execution_batches (id) ON DELETE RESTRICT,
  CONSTRAINT batch_budget_revisions_batch_same_project_fk FOREIGN KEY (project_id, batch_id) REFERENCES execution_batches (project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX batch_budget_revisions_batch_version_unique ON batch_budget_revisions (batch_id, version);

CREATE UNIQUE INDEX features_project_phase_id_id_unique ON features (project_id, phase_id, id);

CREATE TRIGGER execution_batches_immutable_columns_update BEFORE UPDATE ON execution_batches
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.project_id IS NOT OLD.project_id
  OR NEW.phase_id IS NOT OLD.phase_id OR NEW.feature_id IS NOT OLD.feature_id
  OR NEW.scope_snapshot IS NOT OLD.scope_snapshot OR NEW.config_snapshot IS NOT OLD.config_snapshot
BEGIN
  SELECT RAISE(ABORT, 'execution_batches immutable scope, config and identity columns cannot be updated');
END;

CREATE TRIGGER runs_immutable_columns_update BEFORE UPDATE ON runs
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.project_id IS NOT OLD.project_id
  OR NEW.batch_id IS NOT OLD.batch_id OR NEW.feature_id IS NOT OLD.feature_id
  OR NEW.purpose IS NOT OLD.purpose OR NEW.input_snapshot IS NOT OLD.input_snapshot
  OR NEW.config_snapshot IS NOT OLD.config_snapshot OR NEW.scope_digest IS NOT OLD.scope_digest
  OR NEW.work_key IS NOT OLD.work_key OR NEW.dispatch_ordinal IS NOT OLD.dispatch_ordinal
  OR NEW.max_attempts_per_run IS NOT OLD.max_attempts_per_run OR NEW.run_time_limit_ms IS NOT OLD.run_time_limit_ms
  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
BEGIN
  SELECT RAISE(ABORT, 'runs immutable input, dispatch identity and time basis columns cannot be updated');
END;

CREATE TRIGGER batch_budget_revisions_immutable_update BEFORE UPDATE ON batch_budget_revisions
BEGIN
  SELECT RAISE(ABORT, 'batch_budget_revisions rows are immutable snapshots');
END;

CREATE TRIGGER batch_budget_revisions_immutable_delete BEFORE DELETE ON batch_budget_revisions
BEGIN
  SELECT RAISE(ABORT, 'batch_budget_revisions rows are immutable snapshots');
END;
`;

/** v10: preserve operation_id publicly, constrain its typed target with real FKs. */
const MIGRATION_010_SQL = `
CREATE UNIQUE INDEX runs_receipt_identity_unique ON runs (project_id, batch_id, id);

CREATE TABLE command_receipts_v10 (
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
  CONSTRAINT command_receipts_scope_check CHECK ((scope_kind = 'project' AND project_id IS NOT NULL) OR (scope_kind IN ('registration','global') AND project_id IS NULL)),
  CONSTRAINT command_receipts_status_check CHECK (status IN ('completed','rejected','accepted')),
  CONSTRAINT command_receipts_completed_check CHECK (status <> 'completed' OR (result_json IS NOT NULL AND result_ref IS NOT NULL AND error_code IS NULL)),
  CONSTRAINT command_receipts_rejected_check CHECK (status <> 'rejected' OR (error_code IS NOT NULL AND result_json IS NULL)),
  CONSTRAINT command_receipts_accepted_check CHECK (status <> 'accepted' OR (operation_id IS NOT NULL AND result_json IS NULL AND result_ref IS NULL AND error_code IS NULL)),
  CONSTRAINT command_receipts_association_check CHECK (
    (receipt_version = 5 AND batch_id IS NULL AND run_id IS NULL) OR
    (receipt_version = 6 AND operation = 'execution.start' AND status = 'accepted' AND scope_kind = 'project'
      AND batch_id IS NOT NULL AND run_id IS NOT NULL AND operation_id = batch_id
      AND error_message IS NULL AND error_details IS NULL)
  ),
  CONSTRAINT command_receipts_digest_check CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*')
);

INSERT INTO command_receipts_v10 (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, operation_id, result_json, result_ref, error_code, error_message, error_details, issued_at, completed_at)
SELECT id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, operation_id, result_json, result_ref, error_code, error_message, error_details, issued_at, completed_at FROM command_receipts;

DROP TABLE command_receipts;
ALTER TABLE command_receipts_v10 RENAME TO command_receipts;
CREATE UNIQUE INDEX command_receipts_principal_command_unique ON command_receipts (principal_id, command_id);
CREATE UNIQUE INDEX command_receipts_result_ref_unique ON command_receipts (result_ref);
CREATE UNIQUE INDEX command_receipts_operation_id_unique ON command_receipts (operation_id);
CREATE INDEX command_receipts_principal_project_index ON command_receipts (principal_id, project_id);
`;

/**
 * v11: P03-3 / F-006 Task 尝试计数列与预占账本表。
 *
 * - tasks 追加执行域累计计数列（设计 11 §3.1 tasks.attempt_counter /
 *   code_attempts_used；总尝试与代码尝试分开）：非负且 code ≤ total 的列级
 *   CHECK 底线（ALTER TABLE ADD COLUMN 的内联 CHECK；不具名——具名约束无法
 *   经 ADD COLUMN 声明，精确范围校验属 ports 契约）；既有行默认 0；
 * - 新建 task_attempt_reservations 预占账本表：受信 Core 分类定值
 *   classified_by='core'（DDL 拒绝任何其他主体，客户端/模型不能自报）、
 *   classification ∈ {code,infrastructure}、幂等身份 UNIQUE(project_id,
 *   task_id,attempt_key)（同身份重放去重、跨 Run 复用冲突）、同项目复合外键
 *   链（execution_batches(project_id,id) / runs(project_id,batch_id,id) /
 *   tasks(project_id,id)，全部 ON DELETE RESTRICT）；
 * - 本迁移不建完整 attempts 表（UNIQUE(task_id,number)、owner/lease/进程字段
 *   属 P03-4 真实 Attempt 生命周期），也不建 workspace_leases/sessions/通知表；
 *   state_events 不加 attempt 关联列（随 attempts 表同迁移加入）。
 */
const MIGRATION_011_SQL = `
ALTER TABLE tasks ADD COLUMN attempt_counter INTEGER NOT NULL DEFAULT 0 CHECK (attempt_counter >= 0);
ALTER TABLE tasks ADD COLUMN code_attempts_used INTEGER NOT NULL DEFAULT 0 CHECK (code_attempts_used >= 0 AND code_attempts_used <= attempt_counter);

CREATE TABLE task_attempt_reservations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  classification TEXT NOT NULL,
  classified_by TEXT NOT NULL,
  reason TEXT,
  CONSTRAINT task_attempt_reservations_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT task_attempt_reservations_attempt_key_not_empty_check CHECK (length(attempt_key) > 0),
  CONSTRAINT task_attempt_reservations_classification_enum_check CHECK (classification IN ('code', 'infrastructure')),
  CONSTRAINT task_attempt_reservations_classified_by_core_check CHECK (classified_by = 'core'),
  CONSTRAINT task_attempt_reservations_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT task_attempt_reservations_batch_fk FOREIGN KEY (project_id, batch_id) REFERENCES execution_batches (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_attempt_reservations_run_fk FOREIGN KEY (project_id, batch_id, run_id) REFERENCES runs (project_id, batch_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_attempt_reservations_task_fk FOREIGN KEY (project_id, task_id) REFERENCES tasks (project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX task_attempt_reservations_task_attempt_key_unique ON task_attempt_reservations (project_id, task_id, attempt_key);
CREATE INDEX task_attempt_reservations_run_id_index ON task_attempt_reservations (run_id);
`;

/**
 * v12: P03-3 / F-007 Runtime 启动额度预占账本表。
 *
 * - 新建 runtime_start_reservations 预占账本表：SDK 启动前原子预占
 *   runtime_starts（设计 04 §6.1「SDK启动前预占runtimeStart额度，启动失败可
 *   保守计数，不盲目退还」）；幂等启动身份 UNIQUE(project_id,start_key)（同身份
 *   重放去重只计一次、跨 Run 复用同身份被 DDL 拒绝——启动身份属于其获准 Run），
 *   同项目复合外键链（execution_batches(project_id,id) / runs(project_id,batch_id,id)，
 *   全部 ON DELETE RESTRICT）；
 * - 账本行只是预占证据：不含 token/cost 用量列、不含 sdk_started/outcome/进程
 *   列（不伪造实际用量或真实 SDK 已启动事实；Runner/停止管理/会话记录属后续
 *   任务），启动失败保守保留计数——无任何退额列或退额原语承载；
 * - 本迁移不建 sessions/recording_manifests 等会话记录表（P03-4），不建
 *   workspace_leases/通知表，state_events 不加 runtime 启动事件类型（派发事件
 *   execution.run.dispatched 语义仍为派发而非已启动）。
 */
const MIGRATION_012_SQL = `
CREATE TABLE runtime_start_reservations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  start_key TEXT NOT NULL,
  CONSTRAINT runtime_start_reservations_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT runtime_start_reservations_start_key_not_empty_check CHECK (length(start_key) > 0),
  CONSTRAINT runtime_start_reservations_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT runtime_start_reservations_batch_fk FOREIGN KEY (project_id, batch_id) REFERENCES execution_batches (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT runtime_start_reservations_run_fk FOREIGN KEY (project_id, batch_id, run_id) REFERENCES runs (project_id, batch_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX runtime_start_reservations_project_start_key_unique ON runtime_start_reservations (project_id, start_key);
CREATE INDEX runtime_start_reservations_run_id_index ON runtime_start_reservations (run_id);
`;

/**
 * v13: P03-3 / F-008 Run 结果结算账本与时间依据保护。
 *
 * - 新建 run_outcome_settlements 结算账本表：受信 Core 内部结算入口一次性
 *   记录 Run 结果与 Batch 无进展计数（设计 04 §6.1「记录结果 不退还 Run 次数」
 *   「连续无进展次数仅在有效 Task 通过、批准的新产物或其他预定义领域进展时
 *   重置，不能靠模型报告成功重置」）；幂等结算身份 UNIQUE(project_id,result_key)
 *   （同 resultKey 重放去重不重复调账、跨 Run 复用同身份被 DDL 拒绝——结算身份
 *   属于其 Run），生效进展证据部分唯一索引（同 (project_id,progress_task_id)
 *   的 new_valid_task_passed 证据至多一条——重放旧成功证据不得再次重置计数），
 *   同项目复合外键链（execution_batches(project_id,id) / runs(project_id,batch_id,id) /
 *   tasks(project_id,id) 进展证据归属，全部 ON DELETE RESTRICT）；
 * - 结算行是不可变证据行（UPDATE/DELETE 一律拒绝，与 batch_budget_revisions 同
 *   风格）：outcome 仅终态（succeeded/failed/cancelled），progress_type 冻结为
 *   none/new_valid_task_passed 两枚举（运行成功文本、SDK 正常结束、心跳、日志、
 *   换模型都不是进展类型——不进入 DDL 枚举，输入面即拒绝）；无 token/cost
 *   用量列（用量结算属后续任务，不伪造）；
 * - runs.ended_at 结算后不可重写触发器：时间依据（started_at 已由 v9 保护）在
 *   重开、暂停及后续 Run 中保持不变，终态不得倒写；首次设定（NULL→值）仍允许；
 * - 本迁移不建 Verifier/check_results 表（结算入口不代替后续 Verifier）、不建
 *   暂停/取消/恢复流程表，state_events 不加结算事件类型（查询面属 F-010）。
 */
const MIGRATION_013_SQL = `
ALTER TABLE tasks ADD COLUMN first_passed_at INTEGER
  CONSTRAINT tasks_first_passed_at_positive_check CHECK (first_passed_at IS NULL OR first_passed_at >= 1);

-- Existing passes are historical facts, not progress produced by a later Run.
UPDATE tasks SET first_passed_at = updated_at WHERE status = 'passed';

CREATE TRIGGER tasks_first_passed_at_insert AFTER INSERT ON tasks
WHEN NEW.status = 'passed' AND NEW.first_passed_at IS NULL
BEGIN
  UPDATE tasks SET first_passed_at = NEW.updated_at WHERE id = NEW.id;
END;

CREATE TRIGGER tasks_first_passed_at_record AFTER UPDATE OF status ON tasks
WHEN OLD.status <> 'passed' AND NEW.status = 'passed' AND OLD.first_passed_at IS NULL
BEGIN
  UPDATE tasks SET first_passed_at = NEW.updated_at WHERE id = NEW.id;
END;

CREATE TRIGGER tasks_first_passed_at_immutable BEFORE UPDATE ON tasks
WHEN OLD.first_passed_at IS NOT NULL AND NEW.first_passed_at IS NOT OLD.first_passed_at
BEGIN
  SELECT RAISE(ABORT, 'task first_passed_at is immutable');
END;

CREATE TABLE run_outcome_settlements (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  result_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  progress_type TEXT NOT NULL,
  progress_task_id TEXT,
  run_ended_at INTEGER NOT NULL,
  no_progress_runs_after INTEGER NOT NULL,
  reason TEXT,
  CONSTRAINT run_outcome_settlements_revision_positive_check CHECK (revision >= 1),
  CONSTRAINT run_outcome_settlements_result_key_not_empty_check CHECK (length(result_key) > 0),
  CONSTRAINT run_outcome_settlements_outcome_terminal_check CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
  CONSTRAINT run_outcome_settlements_progress_type_enum_check CHECK (progress_type IN ('none', 'new_valid_task_passed')),
  CONSTRAINT run_outcome_settlements_progress_shape_check CHECK (
    (progress_type = 'none' AND progress_task_id IS NULL)
    OR (progress_type = 'new_valid_task_passed' AND progress_task_id IS NOT NULL AND length(progress_task_id) > 0)
  ),
  CONSTRAINT run_outcome_settlements_run_ended_at_positive_check CHECK (run_ended_at >= 1),
  CONSTRAINT run_outcome_settlements_no_progress_after_non_negative_check CHECK (no_progress_runs_after >= 0),
  CONSTRAINT run_outcome_settlements_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT run_outcome_settlements_batch_fk FOREIGN KEY (project_id, batch_id) REFERENCES execution_batches (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT run_outcome_settlements_run_fk FOREIGN KEY (project_id, batch_id, run_id) REFERENCES runs (project_id, batch_id, id) ON DELETE RESTRICT,
  CONSTRAINT run_outcome_settlements_progress_task_fk FOREIGN KEY (project_id, progress_task_id) REFERENCES tasks (project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX run_outcome_settlements_project_result_key_unique ON run_outcome_settlements (project_id, result_key);
CREATE UNIQUE INDEX run_outcome_settlements_progress_evidence_unique ON run_outcome_settlements (project_id, progress_task_id) WHERE progress_type = 'new_valid_task_passed';
CREATE UNIQUE INDEX run_outcome_settlements_run_id_unique ON run_outcome_settlements (run_id);

CREATE TRIGGER run_outcome_settlements_immutable_update BEFORE UPDATE ON run_outcome_settlements
BEGIN
  SELECT RAISE(ABORT, 'run outcome settlement rows are immutable evidence');
END;

CREATE TRIGGER run_outcome_settlements_immutable_delete BEFORE DELETE ON run_outcome_settlements
BEGIN
  SELECT RAISE(ABORT, 'run outcome settlement rows are immutable evidence');
END;

CREATE TRIGGER runs_ended_at_immutable_update BEFORE UPDATE ON runs
WHEN OLD.ended_at IS NOT NULL AND NEW.ended_at IS NOT OLD.ended_at
BEGIN
  SELECT RAISE(ABORT, 'runs ended_at cannot be rewritten after settlement');
END;
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
  {
    version: 5,
    sql: MIGRATION_005_SQL,
    checksum: sha256Hex(MIGRATION_005_SQL),
  },
  {
    version: 6,
    sql: MIGRATION_006_SQL,
    checksum: sha256Hex(MIGRATION_006_SQL),
  },
  {
    version: 7,
    sql: MIGRATION_007_SQL,
    checksum: sha256Hex(MIGRATION_007_SQL),
  },
  {
    version: 8,
    sql: MIGRATION_008_SQL,
    checksum: sha256Hex(MIGRATION_008_SQL),
  },
  {
    version: 9,
    sql: MIGRATION_009_SQL,
    checksum: sha256Hex(MIGRATION_009_SQL),
  },
  {
    version: 10,
    sql: MIGRATION_010_SQL,
    checksum: sha256Hex(MIGRATION_010_SQL),
  },
  {
    version: 11,
    sql: MIGRATION_011_SQL,
    checksum: sha256Hex(MIGRATION_011_SQL),
  },
  {
    version: 12,
    sql: MIGRATION_012_SQL,
    checksum: sha256Hex(MIGRATION_012_SQL),
  },
  {
    version: 13,
    sql: MIGRATION_013_SQL,
    checksum: sha256Hex(MIGRATION_013_SQL),
  },
];
