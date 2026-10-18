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
  /**
   * 重建被其他表外键引用的既有表时置 true（缺省 false）：迁移器在事务外先
   * PRAGMA foreign_keys=OFF（事务内切换无效），执行后于同一事务内做全库
   * foreign_key_check，发现违规整组回滚；finally 恢复 foreign_keys=ON。
   * 仅限表重建类迁移使用；常规增量迁移保持默认的 foreign_keys=ON 执行。
   */
  readonly foreignKeysOff?: boolean;
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

const MIGRATION_014_SQL = `
CREATE UNIQUE INDEX runs_feature_id_id_unique ON runs (feature_id, id);
CREATE UNIQUE INDEX artifacts_project_id_id_unique ON artifacts (project_id, id);
ALTER TABLE tasks ADD COLUMN execution_version INTEGER NOT NULL DEFAULT 0
  CONSTRAINT tasks_execution_version_non_negative_check CHECK (typeof(execution_version) = 'integer' AND execution_version >= 0);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  feature_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  execution_version INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing',
  execution_stage TEXT NOT NULL DEFAULT 'preflight',
  input_snapshot TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  session_id TEXT,
  invocation_id TEXT,
  code_ref TEXT,
  error_kind TEXT,
  diagnostic_ref TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  exit_code INTEGER,
  usage_summary TEXT,
  CONSTRAINT attempts_revision_check CHECK (revision >= 1),
  CONSTRAINT attempts_number_check CHECK (typeof(number) = 'integer' AND number >= 1),
  CONSTRAINT attempts_version_check CHECK (typeof(execution_version) = 'integer' AND execution_version >= 1),
  CONSTRAINT attempts_owner_check CHECK (length(owner_id) > 0 AND length(host_instance_id) > 0),
  CONSTRAINT attempts_lease_check CHECK (typeof(lease_until) = 'integer' AND lease_until >= 0),
  CONSTRAINT attempts_status_check CHECK (status IN ('preparing', 'executing', 'verifying', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  CONSTRAINT attempts_stage_check CHECK (execution_stage IN ('preflight', 'runtime', 'verification', 'commit', 'cleanup')),
  CONSTRAINT attempts_snapshot_check CHECK (CASE WHEN json_valid(input_snapshot) THEN
    json_type(input_snapshot) = 'object' AND json_type(input_snapshot, '$.schemaVersion') IS 'integer'
    AND json_extract(input_snapshot, '$.schemaVersion') = 1
    AND json_extract(input_snapshot, '$.projectId') IS project_id
    AND json_extract(input_snapshot, '$.featureId') IS feature_id
    AND json_extract(input_snapshot, '$.taskId') IS task_id
    AND json_extract(input_snapshot, '$.digests.snapshotDigest') IS input_digest
    AND json_extract(input_snapshot, '$.group.snapshot.artifactId') IS input_ref
    ELSE 0 END),
  CONSTRAINT attempts_digest_check CHECK (length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT attempts_duration_check CHECK (duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0)),
  CONSTRAINT attempts_exit_check CHECK (exit_code IS NULL OR typeof(exit_code) = 'integer'),
  CONSTRAINT attempts_times_check CHECK ((started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at >= 0))
    AND (ended_at IS NULL OR (typeof(ended_at) = 'integer' AND ended_at >= 0))
    AND (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at)),
  CONSTRAINT attempts_usage_check CHECK (usage_summary IS NULL OR CASE WHEN json_valid(usage_summary) THEN
    json_type(usage_summary) = 'object' AND json_type(usage_summary, '$.schemaVersion') IS 'integer'
    AND json_extract(usage_summary, '$.schemaVersion') = 1 ELSE 0 END),
  CONSTRAINT attempts_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT attempts_feature_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_run_fk FOREIGN KEY (feature_id, run_id) REFERENCES runs (feature_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_task_fk FOREIGN KEY (feature_id, task_id) REFERENCES tasks (feature_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_input_fk FOREIGN KEY (project_id, input_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_code_fk FOREIGN KEY (project_id, code_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_diagnostic_fk FOREIGN KEY (project_id, diagnostic_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX attempts_project_id_id_unique ON attempts (project_id, id);
CREATE UNIQUE INDEX attempts_task_number_unique ON attempts (task_id, number);
CREATE UNIQUE INDEX attempts_active_task_unique ON attempts (task_id) WHERE status IN ('preparing', 'executing', 'verifying');
CREATE UNIQUE INDEX attempts_session_unique ON attempts (session_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX attempts_invocation_unique ON attempts (invocation_id) WHERE invocation_id IS NOT NULL;
CREATE INDEX attempts_run_id_index ON attempts (run_id);

CREATE TRIGGER attempts_group_artifacts_check BEFORE INSERT ON attempts
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.input_snapshot, '$.group') AS ref
  WHERE NOT EXISTS (SELECT 1 FROM artifacts AS a WHERE a.project_id = NEW.project_id
    AND a.id = json_extract(ref.value, '$.artifactId') AND a.status = 'ready'
    AND a.version = json_extract(ref.value, '$.version')
    AND a.content_hash = json_extract(ref.value, '$.contentHash')
    AND a.size_bytes = json_extract(ref.value, '$.sizeBytes')
    AND a.storage_locator = json_extract(ref.value, '$.locator')
    AND a.media_type = json_extract(ref.value, '$.mediaType'))
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.input_snapshot, '$.requiredInputs') AS ref
  WHERE NOT EXISTS (SELECT 1 FROM artifacts AS a WHERE a.project_id = NEW.project_id
    AND json_extract(ref.value, '$.projectId') = NEW.project_id
    AND a.id = json_extract(ref.value, '$.artifactId') AND a.status = 'ready'
    AND a.version = json_extract(ref.value, '$.version')
    AND a.content_hash = json_extract(ref.value, '$.contentHash')
    AND a.size_bytes = json_extract(ref.value, '$.sizeBytes')
    AND a.storage_locator = json_extract(ref.value, '$.locator')
    AND a.media_type = json_extract(ref.value, '$.mediaType'))
)
BEGIN SELECT RAISE(ABORT, 'attempt input artifact identity mismatch'); END;

CREATE TRIGGER attempts_input_immutable BEFORE UPDATE ON attempts
WHEN NEW.input_snapshot IS NOT OLD.input_snapshot OR NEW.input_digest IS NOT OLD.input_digest
  OR NEW.input_ref IS NOT OLD.input_ref OR NEW.project_id IS NOT OLD.project_id
  OR NEW.feature_id IS NOT OLD.feature_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.run_id IS NOT OLD.run_id OR NEW.number IS NOT OLD.number
  OR NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.host_instance_id IS NOT OLD.host_instance_id OR NEW.execution_version IS NOT OLD.execution_version
  OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
  OR (OLD.invocation_id IS NOT NULL AND NEW.invocation_id IS NOT OLD.invocation_id)
BEGIN SELECT RAISE(ABORT, 'attempt input and business identity are immutable'); END;

CREATE TABLE workspace_leases (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  resource_key TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  execution_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'held',
  lease_until INTEGER NOT NULL,
  process_identity TEXT,
  CONSTRAINT workspace_leases_revision_check CHECK (revision >= 1),
  CONSTRAINT workspace_leases_resource_check CHECK (length(resource_key) > 0 AND resource_kind IN ('global', 'project', 'workspace')),
  CONSTRAINT workspace_leases_owner_check CHECK (owner_kind = 'attempt' AND length(host_instance_id) > 0),
  CONSTRAINT workspace_leases_version_check CHECK (typeof(execution_version) = 'integer' AND execution_version >= 1),
  CONSTRAINT workspace_leases_state_check CHECK (state IN ('held', 'quarantined')),
  CONSTRAINT workspace_leases_lease_check CHECK (typeof(lease_until) = 'integer' AND lease_until >= 0),
  CONSTRAINT workspace_leases_process_check CHECK (process_identity IS NULL OR (json_valid(process_identity) AND json_type(process_identity) = 'object')),
  CONSTRAINT workspace_leases_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_leases_attempt_fk FOREIGN KEY (project_id, owner_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX workspace_leases_resource_key_unique ON workspace_leases (resource_key);
CREATE INDEX workspace_leases_owner_id_index ON workspace_leases (owner_id);
`;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const MIGRATION_015_SQL = `
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'coding'
  CONSTRAINT tasks_kind_check CHECK (kind IN ('coding', 'planning'));
ALTER TABLE tasks ADD COLUMN manual_block INTEGER NOT NULL DEFAULT 0
  CONSTRAINT tasks_manual_block_check CHECK (typeof(manual_block) = 'integer' AND manual_block IN (0, 1));
`;

const MIGRATION_016_SQL = `
CREATE TABLE task_claim_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  receipt TEXT NOT NULL,
  CONSTRAINT task_claim_receipts_id_check CHECK (length(id) > 0),
  CONSTRAINT task_claim_receipts_digest_check CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT task_claim_receipts_json_check CHECK (CASE WHEN json_valid(receipt) THEN
    json_type(receipt) = 'object' AND json_extract(receipt, '$.schemaVersion') IS 1
    AND json_extract(receipt, '$.claimKey') IS id
    AND json_extract(receipt, '$.attempt.id') IS attempt_id
    AND json_extract(receipt, '$.attempt.projectId') IS project_id ELSE 0 END),
  CONSTRAINT task_claim_receipts_attempt_fk FOREIGN KEY (project_id, attempt_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX task_claim_receipts_attempt_unique ON task_claim_receipts (attempt_id);
CREATE TRIGGER task_claim_receipts_immutable_update BEFORE UPDATE ON task_claim_receipts
BEGIN SELECT RAISE(ABORT, 'task claim receipts are immutable'); END;
CREATE TRIGGER task_claim_receipts_immutable_delete BEFORE DELETE ON task_claim_receipts
BEGIN SELECT RAISE(ABORT, 'task claim receipts are immutable'); END;
`;

const MIGRATION_017_SQL = `
CREATE TABLE attempt_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  receipt TEXT NOT NULL,
  CONSTRAINT attempt_notifications_digest_check CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT attempt_notifications_receipt_check CHECK (length(receipt) <= 8192 AND json_valid(receipt) AND json_type(receipt) = 'object'),
  FOREIGN KEY (project_id, attempt_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX attempt_notifications_identity_unique ON attempt_notifications (attempt_id, notification_id);
CREATE TRIGGER attempt_notifications_immutable_update BEFORE UPDATE ON attempt_notifications
BEGIN SELECT RAISE(ABORT, 'attempt notifications are immutable'); END;
CREATE TRIGGER attempt_notifications_immutable_delete BEFORE DELETE ON attempt_notifications
BEGIN SELECT RAISE(ABORT, 'attempt notifications are immutable'); END;
CREATE TABLE attempt_notification_diagnostics (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  notification_digest TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  CONSTRAINT attempt_diagnostics_digest_check CHECK (length(notification_digest) = 64 AND notification_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT attempt_diagnostics_reason_check CHECK (reason IN ('stale_execution_identity', 'invalid_transition', 'notification_id_reused')),
  CONSTRAINT attempt_diagnostics_time_check CHECK (occurred_at >= 0),
  FOREIGN KEY (project_id, attempt_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX attempt_diagnostics_identity_unique ON attempt_notification_diagnostics (attempt_id, notification_digest);
CREATE TRIGGER attempt_diagnostics_bounded BEFORE INSERT ON attempt_notification_diagnostics
WHEN (SELECT count(*) FROM attempt_notification_diagnostics WHERE attempt_id = NEW.attempt_id) >= 32
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER attempt_diagnostics_immutable_update BEFORE UPDATE ON attempt_notification_diagnostics
BEGIN SELECT RAISE(ABORT, 'attempt diagnostics are immutable'); END;
CREATE TRIGGER attempt_diagnostics_immutable_delete BEFORE DELETE ON attempt_notification_diagnostics
BEGIN SELECT RAISE(ABORT, 'attempt diagnostics are immutable'); END;
`;

const MIGRATION_018_SQL = `
ALTER TABLE state_events ADD COLUMN operation_id TEXT;
ALTER TABLE state_events ADD COLUMN run_id TEXT;
ALTER TABLE state_events ADD COLUMN attempt_id TEXT;
ALTER TABLE state_events ADD COLUMN execution_stage TEXT;

CREATE UNIQUE INDEX runs_project_id_id_unique ON runs (project_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_project_id_id_unique ON attempts (project_id, id);

CREATE TABLE managed_workspaces (
  id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, feature_id TEXT NOT NULL,
  repository_binding_id TEXT NOT NULL, repository_binding_revision INTEGER NOT NULL, repo_identity TEXT NOT NULL,
  canonical_path TEXT NOT NULL, git_common_dir TEXT NOT NULL, branch TEXT NOT NULL, base_commit TEXT NOT NULL,
  head_commit TEXT, code_digest TEXT, status TEXT NOT NULL, preparation_operation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, host_instance_id TEXT NOT NULL, execution_version INTEGER NOT NULL,
  run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  CONSTRAINT managed_workspaces_revision_check CHECK (revision >= 1),
  CONSTRAINT managed_workspaces_status_check CHECK (status IN ('preparing','ready','retained','quarantined','cleanup_pending','cleaned')),
  CONSTRAINT managed_workspaces_base_commit_check CHECK (length(base_commit) IN (40,64) AND base_commit NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT managed_workspaces_code_digest_check CHECK (code_digest IS NULL OR (length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT managed_workspaces_revision_binding_check CHECK (repository_binding_revision >= 1),
  CONSTRAINT managed_workspaces_execution_version_check CHECK (execution_version >= 1),
  CONSTRAINT managed_workspaces_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT managed_workspaces_feature_same_project_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT managed_workspaces_binding_same_project_fk FOREIGN KEY (project_id, repository_binding_id) REFERENCES repository_bindings (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT managed_workspaces_run_same_project_fk FOREIGN KEY (project_id, run_id) REFERENCES runs (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT managed_workspaces_attempt_same_project_fk FOREIGN KEY (project_id, attempt_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX managed_workspaces_project_feature_unique ON managed_workspaces (project_id, feature_id);
CREATE UNIQUE INDEX managed_workspaces_canonical_path_unique ON managed_workspaces (canonical_path);
CREATE UNIQUE INDEX managed_workspaces_project_id_id_unique ON managed_workspaces (project_id, id);
CREATE INDEX managed_workspaces_project_updated_index ON managed_workspaces (project_id, updated_at, id);

CREATE TABLE workspace_operations (
  id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, feature_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, host_instance_id TEXT NOT NULL, execution_version INTEGER NOT NULL,
  kind TEXT NOT NULL, execution_stage TEXT NOT NULL, principal_id TEXT NOT NULL,
  command_id TEXT NOT NULL, request_digest TEXT NOT NULL, input_snapshot TEXT NOT NULL,
  status TEXT NOT NULL, result_json TEXT, receipt_id TEXT NOT NULL, finish_snapshot TEXT,
  CONSTRAINT workspace_operations_revision_check CHECK (revision >= 1),
  CONSTRAINT workspace_operations_kind_check CHECK (kind IN ('prepare','retain','cleanup')),
  CONSTRAINT workspace_operations_stage_check CHECK (execution_stage IN ('preflight','runtime','verification','commit','cleanup')),
  CONSTRAINT workspace_operations_status_check CHECK (status IN ('pending','succeeded','failed','blocked')),
  CONSTRAINT workspace_operations_digest_check CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT workspace_operations_input_json_check CHECK (json_valid(input_snapshot) AND json_type(input_snapshot) = 'object'),
  CONSTRAINT workspace_operations_result_json_check CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
  CONSTRAINT workspace_operations_finish_json_check CHECK (finish_snapshot IS NULL OR (json_valid(finish_snapshot) AND json_type(finish_snapshot) = 'object')),
  CONSTRAINT workspace_operations_execution_version_check CHECK (execution_version >= 1),
  CONSTRAINT workspace_operations_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_workspace_fk FOREIGN KEY (project_id, workspace_id) REFERENCES managed_workspaces (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_feature_same_project_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_run_same_project_fk FOREIGN KEY (project_id, run_id) REFERENCES runs (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_attempt_same_project_fk FOREIGN KEY (project_id, attempt_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_receipt_fk FOREIGN KEY (receipt_id) REFERENCES command_receipts (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX workspace_operations_principal_command_unique ON workspace_operations (principal_id, command_id);
CREATE UNIQUE INDEX workspace_operations_project_id_id_unique ON workspace_operations (project_id, id);
CREATE INDEX workspace_operations_project_created_index ON workspace_operations (project_id, created_at, id);

CREATE TRIGGER managed_workspaces_execution_identity BEFORE INSERT ON managed_workspaces
WHEN NOT EXISTS (SELECT 1 FROM attempts a JOIN tasks t ON t.id = a.task_id
  WHERE a.project_id = NEW.project_id AND a.id = NEW.attempt_id AND a.run_id = NEW.run_id
    AND t.feature_id = NEW.feature_id AND a.owner_id = NEW.owner_id AND a.host_instance_id = NEW.host_instance_id
    AND a.execution_version = NEW.execution_version AND t.execution_version = NEW.execution_version)
BEGIN SELECT RAISE(ABORT, 'managed workspace execution identity mismatch'); END;
CREATE TRIGGER workspace_operations_execution_identity BEFORE INSERT ON workspace_operations
WHEN NOT EXISTS (SELECT 1 FROM attempts a JOIN tasks t ON t.id = a.task_id
  JOIN managed_workspaces w ON w.id = NEW.workspace_id AND w.project_id = NEW.project_id AND w.feature_id = NEW.feature_id
  WHERE a.project_id = NEW.project_id AND a.id = NEW.attempt_id AND a.run_id = NEW.run_id
    AND t.feature_id = NEW.feature_id AND a.owner_id = NEW.owner_id AND a.host_instance_id = NEW.host_instance_id
    AND a.execution_version = NEW.execution_version AND t.execution_version = NEW.execution_version)
BEGIN SELECT RAISE(ABORT, 'workspace operation execution identity mismatch'); END;
CREATE TRIGGER managed_workspaces_immutable_baseline BEFORE UPDATE OF project_id, feature_id, repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, branch, base_commit, preparation_operation_id, run_id, attempt_id, owner_id, host_instance_id, execution_version ON managed_workspaces
BEGIN SELECT RAISE(ABORT, 'managed workspace baseline is immutable'); END;
CREATE TRIGGER workspace_operations_immutable_input BEFORE UPDATE OF project_id, feature_id, workspace_id, run_id, attempt_id, owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest, input_snapshot ON workspace_operations
BEGIN SELECT RAISE(ABORT, 'workspace operation intent is immutable'); END;
CREATE TRIGGER workspace_operations_immutable_result BEFORE UPDATE ON workspace_operations
WHEN OLD.status != 'pending'
BEGIN SELECT RAISE(ABORT, 'workspace operation result is immutable'); END;
`;

/**
 * v19: P03-5 / F-010 人工丢弃 operation kind（workspace_operations 追加
 * 'discard' 枚举值）。SQLite 不能 ALTER CHECK，按既有先例（v5/v10
 * command_receipts 重建）重建子表：新建 workspace_operations_v19（除
 * kind_check 外逐列/约束/外键一致）→ 整表复制 → DROP 旧表（无其他表引用
 * workspace_operations，子表删除不触碰父表 managed_workspaces）→ RENAME →
 * 重建索引与三个不变量触发器。历史行、迁移记录与 checksum 不变；
 * managed_workspaces 不变（丢弃终态复用 'cleaned'：目录确证消失、审计保留）。
 */
const MIGRATION_019_SQL = `
CREATE TABLE workspace_operations_v19 (
  id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, feature_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, host_instance_id TEXT NOT NULL, execution_version INTEGER NOT NULL,
  kind TEXT NOT NULL, execution_stage TEXT NOT NULL, principal_id TEXT NOT NULL,
  command_id TEXT NOT NULL, request_digest TEXT NOT NULL, input_snapshot TEXT NOT NULL,
  status TEXT NOT NULL, result_json TEXT, receipt_id TEXT NOT NULL, finish_snapshot TEXT,
  CONSTRAINT workspace_operations_revision_check CHECK (revision >= 1),
  CONSTRAINT workspace_operations_kind_check CHECK (kind IN ('prepare','retain','cleanup','discard')),
  CONSTRAINT workspace_operations_stage_check CHECK (execution_stage IN ('preflight','runtime','verification','commit','cleanup')),
  CONSTRAINT workspace_operations_status_check CHECK (status IN ('pending','succeeded','failed','blocked')),
  CONSTRAINT workspace_operations_digest_check CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT workspace_operations_input_json_check CHECK (json_valid(input_snapshot) AND json_type(input_snapshot) = 'object'),
  CONSTRAINT workspace_operations_result_json_check CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
  CONSTRAINT workspace_operations_finish_json_check CHECK (finish_snapshot IS NULL OR (json_valid(finish_snapshot) AND json_type(finish_snapshot) = 'object')),
  CONSTRAINT workspace_operations_execution_version_check CHECK (execution_version >= 1),
  CONSTRAINT workspace_operations_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_workspace_fk FOREIGN KEY (project_id, workspace_id) REFERENCES managed_workspaces (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_feature_same_project_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_run_same_project_fk FOREIGN KEY (project_id, run_id) REFERENCES runs (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_attempt_same_project_fk FOREIGN KEY (project_id, attempt_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_operations_receipt_fk FOREIGN KEY (receipt_id) REFERENCES command_receipts (id) ON DELETE RESTRICT
);
INSERT INTO workspace_operations_v19 (id, created_at, project_id, revision, updated_at, feature_id, workspace_id, run_id, attempt_id, owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest, input_snapshot, status, result_json, receipt_id, finish_snapshot)
SELECT id, created_at, project_id, revision, updated_at, feature_id, workspace_id, run_id, attempt_id, owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest, input_snapshot, status, result_json, receipt_id, finish_snapshot FROM workspace_operations;
DROP TABLE workspace_operations;
ALTER TABLE workspace_operations_v19 RENAME TO workspace_operations;
CREATE UNIQUE INDEX workspace_operations_principal_command_unique ON workspace_operations (principal_id, command_id);
CREATE UNIQUE INDEX workspace_operations_project_id_id_unique ON workspace_operations (project_id, id);
CREATE INDEX workspace_operations_project_created_index ON workspace_operations (project_id, created_at, id);
CREATE TRIGGER workspace_operations_execution_identity BEFORE INSERT ON workspace_operations
WHEN NOT EXISTS (SELECT 1 FROM attempts a JOIN tasks t ON t.id = a.task_id
  JOIN managed_workspaces w ON w.id = NEW.workspace_id AND w.project_id = NEW.project_id AND w.feature_id = NEW.feature_id
  WHERE a.project_id = NEW.project_id AND a.id = NEW.attempt_id AND a.run_id = NEW.run_id
    AND t.feature_id = NEW.feature_id AND a.owner_id = NEW.owner_id AND a.host_instance_id = NEW.host_instance_id
    AND a.execution_version = NEW.execution_version AND t.execution_version = NEW.execution_version)
BEGIN SELECT RAISE(ABORT, 'workspace operation execution identity mismatch'); END;
CREATE TRIGGER workspace_operations_immutable_input BEFORE UPDATE OF project_id, feature_id, workspace_id, run_id, attempt_id, owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest, input_snapshot ON workspace_operations
BEGIN SELECT RAISE(ABORT, 'workspace operation intent is immutable'); END;
CREATE TRIGGER workspace_operations_immutable_result BEFORE UPDATE ON workspace_operations
WHEN OLD.status != 'pending'
BEGIN SELECT RAISE(ABORT, 'workspace operation result is immutable'); END;
`;

const MIGRATION_020_SQL = `
-- v20（P03-6 / F-006）：最小 Work Session 与 Attempt 执行诊断持久关联。
-- 顶层 Work Session 唯一关联同项目 Attempt（attempt_id 部分唯一）；区分启动预占
-- （reserved）/实际已启动（started）/执行已结束（ended）/已停止（stopped）；可读
-- 实际 runtime、适配版本、输入引用（与 Attempt 输入快照一致）、executionStage、
-- 结果/诊断制品引用与最后活动；保存可见记录范围（recording_watermark）与缺口
-- （recording_gaps）最小元数据。不建 ChatTurn/session_messages/SessionRecorder 表组；
-- 正文一律经 ready Artifact 引用；未知指标保持 NULL。复用既有 Artifact/状态事件/
-- JSON 形状约定，不引入配置/计划版本表。
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
  attempt_id TEXT, parent_session_id TEXT, kind TEXT NOT NULL, title TEXT,
  purpose TEXT NOT NULL, runtime TEXT NOT NULL, adapter_version TEXT NOT NULL,
  provider_session_id TEXT, status TEXT NOT NULL DEFAULT 'reserved',
  execution_stage TEXT NOT NULL DEFAULT 'preflight', input_ref TEXT NOT NULL, result_ref TEXT,
  last_activity_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, stopped_at INTEGER,
  native_ref TEXT, recording_watermark INTEGER, recording_gaps TEXT,
  CONSTRAINT sessions_revision_check CHECK (revision >= 1),
  CONSTRAINT sessions_kind_check CHECK (kind IN ('work', 'chat')),
  CONSTRAINT sessions_status_check CHECK (status IN ('reserved', 'started', 'ended', 'stopped')),
  CONSTRAINT sessions_stage_check CHECK (execution_stage IN ('preflight', 'runtime', 'verification', 'commit', 'cleanup')),
  CONSTRAINT sessions_descriptor_check CHECK (length(purpose) > 0 AND length(runtime) > 0
    AND length(adapter_version) > 0
    AND (provider_session_id IS NULL OR length(provider_session_id) > 0)
    AND (title IS NULL OR (length(title) BETWEEN 1 AND 200))),
  CONSTRAINT sessions_times_check CHECK (typeof(created_at) = 'integer' AND created_at >= 0
    AND typeof(updated_at) = 'integer' AND updated_at >= 0
    AND typeof(last_activity_at) = 'integer' AND last_activity_at >= 0
    AND (started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at >= 0))
    AND (ended_at IS NULL OR (typeof(ended_at) = 'integer' AND ended_at >= 0))
    AND (stopped_at IS NULL OR (typeof(stopped_at) = 'integer' AND stopped_at >= 0))),
  CONSTRAINT sessions_native_ref_check CHECK (native_ref IS NULL OR (json_valid(native_ref)
    AND json_type(native_ref) = 'object'
    AND json_type(native_ref, '$.schemaVersion') IS 'integer'
    AND json_extract(native_ref, '$.schemaVersion') = 1
    AND json_type(native_ref, '$.storageKind') = 'text'
    AND length(json_extract(native_ref, '$.storageKind')) > 0
    AND json_type(native_ref, '$.formatVersion') = 'text'
    AND length(json_extract(native_ref, '$.formatVersion')) > 0)),
  CONSTRAINT sessions_watermark_check CHECK (recording_watermark IS NULL
    OR (typeof(recording_watermark) = 'integer' AND recording_watermark >= 0)),
  CONSTRAINT sessions_gaps_check CHECK (recording_gaps IS NULL OR (json_valid(recording_gaps)
    AND json_type(recording_gaps) = 'array' AND length(recording_gaps) <= 8192)),
  -- 形状：chat 不关联 Attempt；顶层 Work Session 必须关联 Attempt；子 Session 属于父会话。
  CONSTRAINT sessions_lifecycle_shape_check CHECK (
    (kind = 'chat' AND attempt_id IS NULL)
    OR (kind = 'work' AND parent_session_id IS NULL AND attempt_id IS NOT NULL)
    OR (kind = 'work' AND parent_session_id IS NOT NULL AND attempt_id IS NULL)),
  -- 生命周期形状：reserved 无时间/结果；started 必有 started_at；ended 可无 started_at
  -- （启动失败）但时间单调；stopped 必有 ended/stopped 且单调；result_ref 仅 ended/stopped。
  CONSTRAINT sessions_status_shape_check CHECK (
    (status = 'reserved' AND started_at IS NULL AND ended_at IS NULL AND stopped_at IS NULL AND result_ref IS NULL)
    OR (status = 'started' AND started_at IS NOT NULL AND ended_at IS NULL AND stopped_at IS NULL AND result_ref IS NULL)
    OR (status = 'ended' AND ended_at IS NOT NULL AND stopped_at IS NULL
        AND (started_at IS NULL OR ended_at >= started_at))
    OR (status = 'stopped' AND ended_at IS NOT NULL AND stopped_at IS NOT NULL
        AND stopped_at >= ended_at AND (started_at IS NULL OR ended_at >= started_at))),
  CONSTRAINT sessions_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT sessions_attempt_fk FOREIGN KEY (project_id, attempt_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT sessions_parent_fk FOREIGN KEY (project_id, parent_session_id) REFERENCES sessions (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT sessions_input_ref_fk FOREIGN KEY (project_id, input_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT sessions_result_ref_fk FOREIGN KEY (project_id, result_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX sessions_project_id_id_unique ON sessions (project_id, id);
-- 顶层 Work Session 唯一：同一 Attempt 至多一条 Session。
CREATE UNIQUE INDEX sessions_attempt_unique ON sessions (attempt_id) WHERE attempt_id IS NOT NULL;
CREATE INDEX sessions_project_kind_activity_index ON sessions (project_id, kind, last_activity_at);
-- Session 输入引用必须与所关联 Attempt 的输入快照引用一致（防止错误 Attempt 关联）。
CREATE TRIGGER sessions_attempt_input_check BEFORE INSERT ON sessions
WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM attempts WHERE attempts.id = NEW.attempt_id AND attempts.project_id = NEW.project_id
    AND attempts.input_ref = NEW.input_ref)
BEGIN SELECT RAISE(ABORT, 'sessions attempt input mismatch'); END;
-- 结果/诊断制品引用必须指向同项目 ready Artifact（正文不落入 sessions 表）。
CREATE TRIGGER sessions_result_ref_ready_insert BEFORE INSERT ON sessions
WHEN NEW.result_ref IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifacts WHERE artifacts.project_id = NEW.project_id AND artifacts.id = NEW.result_ref
    AND artifacts.status = 'ready')
BEGIN SELECT RAISE(ABORT, 'sessions result artifact is not ready'); END;
CREATE TRIGGER sessions_result_ref_ready_update BEFORE UPDATE OF result_ref ON sessions
WHEN NEW.result_ref IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifacts WHERE artifacts.project_id = NEW.project_id AND artifacts.id = NEW.result_ref
    AND artifacts.status = 'ready')
BEGIN SELECT RAISE(ABORT, 'sessions result artifact is not ready'); END;
-- 身份/运行时/输入列不可变。
CREATE TRIGGER sessions_identity_immutable BEFORE UPDATE ON sessions
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.parent_session_id IS NOT OLD.parent_session_id OR NEW.kind IS NOT OLD.kind
  OR NEW.runtime IS NOT OLD.runtime OR NEW.adapter_version IS NOT OLD.adapter_version
  OR NEW.input_ref IS NOT OLD.input_ref
BEGIN SELECT RAISE(ABORT, 'sessions identity fields are immutable'); END;
-- 已绑定事实只可写一次；记录水位与最后活动只前进不后退。
CREATE TRIGGER sessions_bound_facts_set_once BEFORE UPDATE ON sessions
WHEN (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS NOT OLD.provider_session_id)
  OR (OLD.native_ref IS NOT NULL AND NEW.native_ref IS NOT OLD.native_ref)
  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
  OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS NOT OLD.ended_at)
  OR (OLD.stopped_at IS NOT NULL AND NEW.stopped_at IS NOT OLD.stopped_at)
  OR (OLD.result_ref IS NOT NULL AND NEW.result_ref IS NOT OLD.result_ref)
  OR (OLD.recording_watermark IS NOT NULL
      AND (NEW.recording_watermark IS NULL OR NEW.recording_watermark < OLD.recording_watermark))
  OR NEW.last_activity_at < OLD.last_activity_at
BEGIN SELECT RAISE(ABORT, 'sessions bound facts are set-once or monotonic'); END;
`;

const MIGRATION_021_SQL = `
-- v21（P03-7 / F-002）：VerificationBatch / CheckResult 与不可变验证证据身份。
-- 批次把针对同一代码状态的一组可信检查归为权威边界：关联 Project/Feature/Run/Task/
-- Attempt/executionVersion 与 operation，保存代码身份（code_digest）、检查定义快照
-- （check_snapshot）、策略身份（policy_digest）、环境身份（environment_summary）与
-- 选择/回退理由（selection）；逐项保存状态、argv/cwd/timeout 快照、时间、exit_code/
-- signal、输出 Artifact 引用与有界 tail；未知指标保持 NULL，不填 0。不建
-- check_definitions 表（定义存 settings，批次保存快照）与配置/计划版本表；大输出
-- 正文永不进库，仅引用同项目 ready Artifact 并记录其摘要身份（output_digest）。
CREATE TABLE verification_batches (
  id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
  feature_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, execution_version INTEGER NOT NULL,
  operation TEXT NOT NULL, code_digest TEXT NOT NULL, policy_digest TEXT NOT NULL,
  environment_summary TEXT NOT NULL, check_snapshot TEXT NOT NULL, selection TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', started_at INTEGER, ended_at INTEGER,
  CONSTRAINT verification_batches_revision_check CHECK (revision >= 1),
  CONSTRAINT verification_batches_version_check CHECK (typeof(execution_version) = 'integer' AND execution_version >= 1),
  CONSTRAINT verification_batches_operation_check CHECK (length(operation) > 0 AND length(operation) <= 128),
  CONSTRAINT verification_batches_digest_check CHECK (length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*'
    AND length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT verification_batches_environment_check CHECK (json_valid(environment_summary)
    AND json_type(environment_summary) = 'object' AND length(environment_summary) <= 8192),
  CONSTRAINT verification_batches_snapshot_check CHECK (json_valid(check_snapshot)
    AND json_type(check_snapshot) = 'array' AND json_array_length(check_snapshot) >= 1
    AND length(check_snapshot) <= 65536),
  CONSTRAINT verification_batches_selection_check CHECK (json_valid(selection)
    AND json_type(selection) = 'object' AND length(selection) <= 16384),
  CONSTRAINT verification_batches_status_check CHECK (status IN ('running', 'passed', 'failed', 'error', 'inconclusive')),
  -- 生命周期形状：running 无 ended_at；终态必须有 ended_at 且不早于 started_at；未知时间为 NULL。
  CONSTRAINT verification_batches_times_check CHECK (typeof(created_at) = 'integer' AND created_at >= 0
    AND typeof(updated_at) = 'integer' AND updated_at >= 0
    AND (started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at >= 0))
    AND (ended_at IS NULL OR (typeof(ended_at) = 'integer' AND ended_at >= 0))
    AND ((status = 'running' AND ended_at IS NULL)
      OR (status <> 'running' AND ended_at IS NOT NULL AND (started_at IS NULL OR ended_at >= started_at)))),
  CONSTRAINT verification_batches_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT verification_batches_feature_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT verification_batches_run_fk FOREIGN KEY (project_id, run_id) REFERENCES runs (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT verification_batches_task_fk FOREIGN KEY (feature_id, task_id) REFERENCES tasks (feature_id, id) ON DELETE RESTRICT,
  CONSTRAINT verification_batches_attempt_fk FOREIGN KEY (project_id, attempt_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX verification_batches_project_id_id_unique ON verification_batches (project_id, id);
CREATE INDEX verification_batches_project_attempt_index ON verification_batches (project_id, attempt_id, id);
-- 批次关联必须与 Attempt 当前身份一致（防止跨项目或混用不同 Attempt/代际的验证记录）。
CREATE TRIGGER verification_batches_attempt_identity_check BEFORE INSERT ON verification_batches
WHEN NOT EXISTS (
  SELECT 1 FROM attempts JOIN tasks ON tasks.id = attempts.task_id AND tasks.project_id = attempts.project_id
  WHERE attempts.id = NEW.attempt_id AND attempts.project_id = NEW.project_id
    AND attempts.feature_id = NEW.feature_id AND attempts.run_id = NEW.run_id
    AND attempts.task_id = NEW.task_id AND attempts.execution_version = NEW.execution_version
    AND tasks.execution_version = NEW.execution_version)
BEGIN SELECT RAISE(ABORT, 'verification batch attempt identity mismatch'); END;
-- 身份与快照列不可变（代码身份、检查定义、策略/环境身份与选择理由一经保存不可改写）。
CREATE TRIGGER verification_batches_identity_immutable BEFORE UPDATE ON verification_batches
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.feature_id IS NOT OLD.feature_id
  OR NEW.run_id IS NOT OLD.run_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.execution_version IS NOT OLD.execution_version
  OR NEW.operation IS NOT OLD.operation OR NEW.code_digest IS NOT OLD.code_digest
  OR NEW.policy_digest IS NOT OLD.policy_digest OR NEW.environment_summary IS NOT OLD.environment_summary
  OR NEW.check_snapshot IS NOT OLD.check_snapshot OR NEW.selection IS NOT OLD.selection
  OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'verification batch identity fields are immutable'); END;
-- 定版一次性：仅 running 可进入终态，终态不可改写或回退 running；ended_at 只写一次。
CREATE TRIGGER verification_batches_terminal_immutable BEFORE UPDATE OF status, ended_at ON verification_batches
WHEN OLD.status <> 'running' OR NEW.status = 'running'
  OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS NOT OLD.ended_at)
BEGIN SELECT RAISE(ABORT, 'verification batch terminal status is immutable'); END;
CREATE TABLE check_results (
  id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
  batch_id TEXT NOT NULL, check_key TEXT NOT NULL, argv_json TEXT NOT NULL,
  cwd_ref TEXT, environment_ref TEXT, timeout_ms INTEGER NOT NULL, required INTEGER NOT NULL,
  status TEXT NOT NULL, exit_code INTEGER, signal TEXT, timed_out INTEGER NOT NULL DEFAULT 0,
  output_artifact_id TEXT, output_digest TEXT, output_tail TEXT,
  started_at INTEGER, ended_at INTEGER,
  CONSTRAINT check_results_revision_check CHECK (revision >= 1),
  CONSTRAINT check_results_check_key_check CHECK (length(check_key) > 0 AND length(check_key) <= 128),
  CONSTRAINT check_results_status_check CHECK (status IN ('passed', 'failed', 'error', 'inconclusive', 'not_run')),
  CONSTRAINT check_results_argv_json_check CHECK (json_valid(argv_json) AND json_type(argv_json) = 'array'
    AND json_array_length(argv_json) >= 1),
  CONSTRAINT check_results_timeout_check CHECK (typeof(timeout_ms) = 'integer' AND timeout_ms >= 1),
  CONSTRAINT check_results_required_check CHECK (required IN (0, 1)),
  CONSTRAINT check_results_timed_out_check CHECK (timed_out IN (0, 1)),
  CONSTRAINT check_results_exit_check CHECK (exit_code IS NULL OR typeof(exit_code) = 'integer'),
  CONSTRAINT check_results_signal_check CHECK (signal IS NULL OR (length(signal) > 0 AND length(signal) <= 32)),
  CONSTRAINT check_results_digest_check CHECK (output_digest IS NULL
    OR (length(output_digest) = 64 AND output_digest NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT check_results_tail_check CHECK (output_tail IS NULL OR length(output_tail) <= 8192),
  CONSTRAINT check_results_times_check CHECK (typeof(created_at) = 'integer' AND created_at >= 0
    AND typeof(updated_at) = 'integer' AND updated_at >= 0
    AND (started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at >= 0))
    AND (ended_at IS NULL OR (typeof(ended_at) = 'integer' AND ended_at >= 0))
    AND (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at)),
  -- 证据身份形状：制品引用与记录摘要同时存在或同时为 NULL。
  CONSTRAINT check_results_output_shape_check CHECK ((output_artifact_id IS NULL) = (output_digest IS NULL)),
  -- 状态形状：not_run 无退出码/信号/超时/时间；passed 必须 exit_code=0 且未超时；
  -- 超时只允许 failed/error（未知指标保持 NULL，不填 0）。
  CONSTRAINT check_results_status_shape_check CHECK (
    (status = 'not_run' AND exit_code IS NULL AND signal IS NULL AND timed_out = 0
      AND started_at IS NULL AND ended_at IS NULL)
    OR (status = 'passed' AND exit_code = 0 AND timed_out = 0)
    OR (status IN ('failed', 'error', 'inconclusive'))),
  CONSTRAINT check_results_timed_out_shape_check CHECK (timed_out = 0 OR status IN ('failed', 'error')),
  CONSTRAINT check_results_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT check_results_batch_fk FOREIGN KEY (project_id, batch_id) REFERENCES verification_batches (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT check_results_output_artifact_fk FOREIGN KEY (project_id, output_artifact_id) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX check_results_project_id_id_unique ON check_results (project_id, id);
CREATE UNIQUE INDEX check_results_batch_check_unique ON check_results (batch_id, check_key);
-- 输出证据引用必须指向同项目 ready Artifact 且记录摘要与实测摘要一致。
CREATE TRIGGER check_results_output_ready_insert BEFORE INSERT ON check_results
WHEN NEW.output_artifact_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifacts WHERE artifacts.project_id = NEW.project_id
    AND artifacts.id = NEW.output_artifact_id AND artifacts.status = 'ready'
    AND artifacts.content_hash = NEW.output_digest)
BEGIN SELECT RAISE(ABORT, 'check result output artifact is not ready or digest mismatch'); END;
-- 逐项结果不可变：结论、定义快照与证据身份一经保存不可改写（历史失败记录不被覆盖）。
CREATE TRIGGER check_results_immutable_update BEFORE UPDATE ON check_results
BEGIN SELECT RAISE(ABORT, 'check results are immutable'); END;
`;

const MIGRATION_022_SQL = `
CREATE TABLE task_approval_items (
  id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, project_id TEXT NOT NULL,
  feature_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL,
  responsible_party TEXT NOT NULL, plan_digest TEXT NOT NULL, code_digest TEXT,
  artifact_refs TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', created_by TEXT NOT NULL,
  CONSTRAINT task_approval_items_revision_check CHECK (revision >= 1),
  CONSTRAINT task_approval_items_kind_check CHECK (kind IN ('block', 'approval')),
  CONSTRAINT task_approval_items_status_check CHECK (status = 'pending'),
  CONSTRAINT task_approval_items_plan_digest_check CHECK (length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT task_approval_items_code_digest_check CHECK (code_digest IS NULL OR (length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT task_approval_items_artifacts_check CHECK (json_valid(artifact_refs) AND json_type(artifact_refs) = 'array'),
  CONSTRAINT task_approval_items_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT task_approval_items_feature_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_approval_items_task_fk FOREIGN KEY (feature_id, task_id) REFERENCES tasks (feature_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX task_approval_items_project_id_id_unique ON task_approval_items (project_id, id);
CREATE UNIQUE INDEX task_approval_items_task_identity_unique ON task_approval_items (project_id, feature_id, task_id, kind, description, responsible_party, plan_digest, code_digest, artifact_refs);
CREATE INDEX task_approval_items_task_status_index ON task_approval_items (project_id, task_id, status);
`;

/** F-008：为人审事项增加不可变决定事实与终态；历史 pending 行逐条保留。 */
const MIGRATION_023_SQL = `
CREATE TABLE task_approval_items_v23 (
  id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, project_id TEXT NOT NULL,
  feature_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL,
  responsible_party TEXT NOT NULL, plan_digest TEXT NOT NULL, code_digest TEXT,
  artifact_refs TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', created_by TEXT NOT NULL,
  decision TEXT, decision_actor TEXT, decision_reason TEXT, decision_code_digest TEXT,
  decision_artifact_refs TEXT NOT NULL DEFAULT '[]', decided_at INTEGER,
  CONSTRAINT task_approval_items_revision_check CHECK (revision >= 1),
  CONSTRAINT task_approval_items_kind_check CHECK (kind IN ('block', 'approval')),
  CONSTRAINT task_approval_items_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'unblocked')),
  CONSTRAINT task_approval_items_decision_check CHECK (decision IS NULL OR decision IN ('approve', 'reject', 'unblock')),
  CONSTRAINT task_approval_items_decision_binding_check CHECK ((status = 'pending' AND decision IS NULL AND decision_actor IS NULL AND decided_at IS NULL) OR (status = 'approved' AND decision = 'approve' AND decision_actor IS NOT NULL AND decided_at IS NOT NULL) OR (status = 'rejected' AND decision = 'reject' AND decision_actor IS NOT NULL AND decided_at IS NOT NULL) OR (status = 'unblocked' AND decision = 'unblock' AND decision_actor IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT task_approval_items_plan_digest_check CHECK (length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT task_approval_items_code_digest_check CHECK (code_digest IS NULL OR (length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT task_approval_items_decision_code_digest_check CHECK (decision_code_digest IS NULL OR (length(decision_code_digest) = 64 AND decision_code_digest NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT task_approval_items_artifacts_check CHECK (json_valid(artifact_refs) AND json_type(artifact_refs) = 'array' AND json_valid(decision_artifact_refs) AND json_type(decision_artifact_refs) = 'array'),
  CONSTRAINT task_approval_items_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT task_approval_items_feature_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT task_approval_items_task_fk FOREIGN KEY (feature_id, task_id) REFERENCES tasks (feature_id, id) ON DELETE RESTRICT
);
INSERT INTO task_approval_items_v23 (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description, responsible_party, plan_digest, code_digest, artifact_refs, status, created_by)
  SELECT id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description, responsible_party, plan_digest, code_digest, artifact_refs, status, created_by FROM task_approval_items;
DROP TABLE task_approval_items;
ALTER TABLE task_approval_items_v23 RENAME TO task_approval_items;
CREATE UNIQUE INDEX task_approval_items_project_id_id_unique ON task_approval_items (project_id, id);
CREATE UNIQUE INDEX task_approval_items_task_identity_unique ON task_approval_items (project_id, feature_id, task_id, kind, description, responsible_party, plan_digest, code_digest, artifact_refs);
CREATE INDEX task_approval_items_task_status_index ON task_approval_items (project_id, task_id, status);
`;

/** 已声明的全部 SQLite 迁移，按版本升序；F-005 的执行器按此顺序应用并核对摘要。 */
/**
 * v24: P03-7 / F-011 ContextBuilder 契约升版（schemaVersion 2，可选同 Task 返工
 * 输入）。attempts_snapshot_check 原钉住 input_snapshot.schemaVersion = 1，升版后
 * v1 历史快照与 v2 新快照都必须可持久化；SQLite 不能 ALTER CHECK，重建
 * attempts（除 attempts_snapshot_check 放宽为 IN (1, 2) 外逐列/约束/外键一致）
 * → 整表复制 → DROP → 重建 6 个索引 → RENAME → 重建 2 个不变量触发器。
 * attempts 被 workspace_leases / sessions / task_claim_receipts /
 * verification_batches / workspace_operations / managed_workspaces 等表外键引用；
 * DROP 的隐式 DELETE 无法在 foreign_keys=ON 下安全完成（即时违反或
 * defer_foreign_keys 的挂起违规计数无法经异名表 INSERT 抵消），因此描述符标记
 * foreignKeysOff，由迁移器在事务外关闭外键执行、提交前全库 foreign_key_check
 * 核验一致性后恢复。legacy_alter_table 在事务内启用并在末尾复位，避免 RENAME
 * 重新校验其他表上引用 attempts 的触发器（rename 窗口内 attempts 尚未重建）。
 * 历史行、迁移记录与 checksum 不变。
 */
const MIGRATION_024_SQL = `
PRAGMA legacy_alter_table = ON;

CREATE TABLE attempts_v24 (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  feature_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  execution_version INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing',
  execution_stage TEXT NOT NULL DEFAULT 'preflight',
  input_snapshot TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  session_id TEXT,
  invocation_id TEXT,
  code_ref TEXT,
  error_kind TEXT,
  diagnostic_ref TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  exit_code INTEGER,
  usage_summary TEXT,
  CONSTRAINT attempts_revision_check CHECK (revision >= 1),
  CONSTRAINT attempts_number_check CHECK (typeof(number) = 'integer' AND number >= 1),
  CONSTRAINT attempts_version_check CHECK (typeof(execution_version) = 'integer' AND execution_version >= 1),
  CONSTRAINT attempts_owner_check CHECK (length(owner_id) > 0 AND length(host_instance_id) > 0),
  CONSTRAINT attempts_lease_check CHECK (typeof(lease_until) = 'integer' AND lease_until >= 0),
  CONSTRAINT attempts_status_check CHECK (status IN ('preparing', 'executing', 'verifying', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  CONSTRAINT attempts_stage_check CHECK (execution_stage IN ('preflight', 'runtime', 'verification', 'commit', 'cleanup')),
  CONSTRAINT attempts_snapshot_check CHECK (CASE WHEN json_valid(input_snapshot) THEN
    json_type(input_snapshot) = 'object' AND json_type(input_snapshot, '$.schemaVersion') IS 'integer'
    AND json_extract(input_snapshot, '$.schemaVersion') IN (1, 2)
    AND json_extract(input_snapshot, '$.projectId') IS project_id
    AND json_extract(input_snapshot, '$.featureId') IS feature_id
    AND json_extract(input_snapshot, '$.taskId') IS task_id
    AND json_extract(input_snapshot, '$.digests.snapshotDigest') IS input_digest
    AND json_extract(input_snapshot, '$.group.snapshot.artifactId') IS input_ref
    ELSE 0 END),
  CONSTRAINT attempts_digest_check CHECK (length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT attempts_duration_check CHECK (duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0)),
  CONSTRAINT attempts_exit_check CHECK (exit_code IS NULL OR typeof(exit_code) = 'integer'),
  CONSTRAINT attempts_times_check CHECK ((started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at >= 0))
    AND (ended_at IS NULL OR (typeof(ended_at) = 'integer' AND ended_at >= 0))
    AND (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at)),
  CONSTRAINT attempts_usage_check CHECK (usage_summary IS NULL OR CASE WHEN json_valid(usage_summary) THEN
    json_type(usage_summary) = 'object' AND json_type(usage_summary, '$.schemaVersion') IS 'integer'
    AND json_extract(usage_summary, '$.schemaVersion') = 1 ELSE 0 END),
  CONSTRAINT attempts_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT attempts_feature_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_run_fk FOREIGN KEY (feature_id, run_id) REFERENCES runs (feature_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_task_fk FOREIGN KEY (feature_id, task_id) REFERENCES tasks (feature_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_input_fk FOREIGN KEY (project_id, input_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_code_fk FOREIGN KEY (project_id, code_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_diagnostic_fk FOREIGN KEY (project_id, diagnostic_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT
);
INSERT INTO attempts_v24 (id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, input_digest, input_ref, session_id, invocation_id, code_ref, error_kind, diagnostic_ref, started_at, ended_at, duration_ms, exit_code, usage_summary)
SELECT id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, input_digest, input_ref, session_id, invocation_id, code_ref, error_kind, diagnostic_ref, started_at, ended_at, duration_ms, exit_code, usage_summary FROM attempts;
DROP TABLE attempts;
CREATE UNIQUE INDEX attempts_project_id_id_unique ON attempts_v24 (project_id, id);
CREATE UNIQUE INDEX attempts_task_number_unique ON attempts_v24 (task_id, number);
CREATE UNIQUE INDEX attempts_active_task_unique ON attempts_v24 (task_id) WHERE status IN ('preparing', 'executing', 'verifying');
CREATE UNIQUE INDEX attempts_session_unique ON attempts_v24 (session_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX attempts_invocation_unique ON attempts_v24 (invocation_id) WHERE invocation_id IS NOT NULL;
CREATE INDEX attempts_run_id_index ON attempts_v24 (run_id);
ALTER TABLE attempts_v24 RENAME TO attempts;

CREATE TRIGGER attempts_group_artifacts_check BEFORE INSERT ON attempts
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.input_snapshot, '$.group') AS ref
  WHERE NOT EXISTS (SELECT 1 FROM artifacts AS a WHERE a.project_id = NEW.project_id
    AND a.id = json_extract(ref.value, '$.artifactId') AND a.status = 'ready'
    AND a.version = json_extract(ref.value, '$.version')
    AND a.content_hash = json_extract(ref.value, '$.contentHash')
    AND a.size_bytes = json_extract(ref.value, '$.sizeBytes')
    AND a.storage_locator = json_extract(ref.value, '$.locator')
    AND a.media_type = json_extract(ref.value, '$.mediaType'))
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.input_snapshot, '$.requiredInputs') AS ref
  WHERE NOT EXISTS (SELECT 1 FROM artifacts AS a WHERE a.project_id = NEW.project_id
    AND json_extract(ref.value, '$.projectId') = NEW.project_id
    AND a.id = json_extract(ref.value, '$.artifactId') AND a.status = 'ready'
    AND a.version = json_extract(ref.value, '$.version')
    AND a.content_hash = json_extract(ref.value, '$.contentHash')
    AND a.size_bytes = json_extract(ref.value, '$.sizeBytes')
    AND a.storage_locator = json_extract(ref.value, '$.locator')
    AND a.media_type = json_extract(ref.value, '$.mediaType'))
)
BEGIN SELECT RAISE(ABORT, 'attempt input artifact identity mismatch'); END;

CREATE TRIGGER attempts_input_immutable BEFORE UPDATE ON attempts
WHEN NEW.input_snapshot IS NOT OLD.input_snapshot OR NEW.input_digest IS NOT OLD.input_digest
  OR NEW.input_ref IS NOT OLD.input_ref OR NEW.project_id IS NOT OLD.project_id
  OR NEW.feature_id IS NOT OLD.feature_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.run_id IS NOT OLD.run_id OR NEW.number IS NOT OLD.number
  OR NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.host_instance_id IS NOT OLD.host_instance_id OR NEW.execution_version IS NOT OLD.execution_version
  OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
  OR (OLD.invocation_id IS NOT NULL AND NEW.invocation_id IS NOT OLD.invocation_id)
BEGIN SELECT RAISE(ABORT, 'attempt input and business identity are immutable'); END;

PRAGMA legacy_alter_table = OFF;
`;
/**
 * v25: P03-8 / F-001 ContextBuilder 契约升版（schemaVersion 3，可选交付政策
 * deliveryPolicy 固定进执行输入快照）。attempts_snapshot_check 在 v24 钉住
 * IN (1, 2)，升版后 v1/v2 历史快照与 v3 新快照都必须可持久化；与 v24 同一
 * 纪律重建 attempts（除 attempts_snapshot_check 放宽为 IN (1, 2, 3) 外逐列/
 * 约束/外键一致）→ 整表复制 → DROP → 重建 6 个索引 → RENAME → 重建 2 个
 * 不变量触发器；描述符标记 foreignKeysOff（事务外关外键 + 全库
 * foreign_key_check；legacy_alter_table 同 v24）。历史行、迁移记录与 checksum
 * 不变。
 */
const MIGRATION_025_SQL = `
PRAGMA legacy_alter_table = ON;

CREATE TABLE attempts_v25 (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  feature_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  execution_version INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing',
  execution_stage TEXT NOT NULL DEFAULT 'preflight',
  input_snapshot TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  session_id TEXT,
  invocation_id TEXT,
  code_ref TEXT,
  error_kind TEXT,
  diagnostic_ref TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  exit_code INTEGER,
  usage_summary TEXT,
  CONSTRAINT attempts_revision_check CHECK (revision >= 1),
  CONSTRAINT attempts_number_check CHECK (typeof(number) = 'integer' AND number >= 1),
  CONSTRAINT attempts_version_check CHECK (typeof(execution_version) = 'integer' AND execution_version >= 1),
  CONSTRAINT attempts_owner_check CHECK (length(owner_id) > 0 AND length(host_instance_id) > 0),
  CONSTRAINT attempts_lease_check CHECK (typeof(lease_until) = 'integer' AND lease_until >= 0),
  CONSTRAINT attempts_status_check CHECK (status IN ('preparing', 'executing', 'verifying', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  CONSTRAINT attempts_stage_check CHECK (execution_stage IN ('preflight', 'runtime', 'verification', 'commit', 'cleanup')),
  CONSTRAINT attempts_snapshot_check CHECK (CASE WHEN json_valid(input_snapshot) THEN
    json_type(input_snapshot) = 'object' AND json_type(input_snapshot, '$.schemaVersion') IS 'integer'
    AND json_extract(input_snapshot, '$.schemaVersion') IN (1, 2, 3)
    AND json_extract(input_snapshot, '$.projectId') IS project_id
    AND json_extract(input_snapshot, '$.featureId') IS feature_id
    AND json_extract(input_snapshot, '$.taskId') IS task_id
    AND json_extract(input_snapshot, '$.digests.snapshotDigest') IS input_digest
    AND json_extract(input_snapshot, '$.group.snapshot.artifactId') IS input_ref
    ELSE 0 END),
  CONSTRAINT attempts_digest_check CHECK (length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT attempts_duration_check CHECK (duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0)),
  CONSTRAINT attempts_exit_check CHECK (exit_code IS NULL OR typeof(exit_code) = 'integer'),
  CONSTRAINT attempts_times_check CHECK ((started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at >= 0))
    AND (ended_at IS NULL OR (typeof(ended_at) = 'integer' AND ended_at >= 0))
    AND (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at)),
  CONSTRAINT attempts_usage_check CHECK (usage_summary IS NULL OR CASE WHEN json_valid(usage_summary) THEN
    json_type(usage_summary) = 'object' AND json_type(usage_summary, '$.schemaVersion') IS 'integer'
    AND json_extract(usage_summary, '$.schemaVersion') = 1 ELSE 0 END),
  CONSTRAINT attempts_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT attempts_feature_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_run_fk FOREIGN KEY (feature_id, run_id) REFERENCES runs (feature_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_task_fk FOREIGN KEY (feature_id, task_id) REFERENCES tasks (feature_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_input_fk FOREIGN KEY (project_id, input_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_code_fk FOREIGN KEY (project_id, code_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT attempts_diagnostic_fk FOREIGN KEY (project_id, diagnostic_ref) REFERENCES artifacts (project_id, id) ON DELETE RESTRICT
);
INSERT INTO attempts_v25 (id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, input_digest, input_ref, session_id, invocation_id, code_ref, error_kind, diagnostic_ref, started_at, ended_at, duration_ms, exit_code, usage_summary)
SELECT id, created_at, project_id, revision, updated_at, feature_id, run_id, task_id, number, owner_id, host_instance_id, execution_version, lease_until, status, execution_stage, input_snapshot, input_digest, input_ref, session_id, invocation_id, code_ref, error_kind, diagnostic_ref, started_at, ended_at, duration_ms, exit_code, usage_summary FROM attempts;
DROP TABLE attempts;
CREATE UNIQUE INDEX attempts_project_id_id_unique ON attempts_v25 (project_id, id);
CREATE UNIQUE INDEX attempts_task_number_unique ON attempts_v25 (task_id, number);
CREATE UNIQUE INDEX attempts_active_task_unique ON attempts_v25 (task_id) WHERE status IN ('preparing', 'executing', 'verifying');
CREATE UNIQUE INDEX attempts_session_unique ON attempts_v25 (session_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX attempts_invocation_unique ON attempts_v25 (invocation_id) WHERE invocation_id IS NOT NULL;
CREATE INDEX attempts_run_id_index ON attempts_v25 (run_id);
ALTER TABLE attempts_v25 RENAME TO attempts;

CREATE TRIGGER attempts_group_artifacts_check BEFORE INSERT ON attempts
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.input_snapshot, '$.group') AS ref
  WHERE NOT EXISTS (SELECT 1 FROM artifacts AS a WHERE a.project_id = NEW.project_id
    AND a.id = json_extract(ref.value, '$.artifactId') AND a.status = 'ready'
    AND a.version = json_extract(ref.value, '$.version')
    AND a.content_hash = json_extract(ref.value, '$.contentHash')
    AND a.size_bytes = json_extract(ref.value, '$.sizeBytes')
    AND a.storage_locator = json_extract(ref.value, '$.locator')
    AND a.media_type = json_extract(ref.value, '$.mediaType'))
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.input_snapshot, '$.requiredInputs') AS ref
  WHERE NOT EXISTS (SELECT 1 FROM artifacts AS a WHERE a.project_id = NEW.project_id
    AND json_extract(ref.value, '$.projectId') = NEW.project_id
    AND a.id = json_extract(ref.value, '$.artifactId') AND a.status = 'ready'
    AND a.version = json_extract(ref.value, '$.version')
    AND a.content_hash = json_extract(ref.value, '$.contentHash')
    AND a.size_bytes = json_extract(ref.value, '$.sizeBytes')
    AND a.storage_locator = json_extract(ref.value, '$.locator')
    AND a.media_type = json_extract(ref.value, '$.mediaType'))
)
BEGIN SELECT RAISE(ABORT, 'attempt input artifact identity mismatch'); END;

CREATE TRIGGER attempts_input_immutable BEFORE UPDATE ON attempts
WHEN NEW.input_snapshot IS NOT OLD.input_snapshot OR NEW.input_digest IS NOT OLD.input_digest
  OR NEW.input_ref IS NOT OLD.input_ref OR NEW.project_id IS NOT OLD.project_id
  OR NEW.feature_id IS NOT OLD.feature_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.run_id IS NOT OLD.run_id OR NEW.number IS NOT OLD.number
  OR NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.host_instance_id IS NOT OLD.host_instance_id OR NEW.execution_version IS NOT OLD.execution_version
  OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
  OR (OLD.invocation_id IS NOT NULL AND NEW.invocation_id IS NOT OLD.invocation_id)
BEGIN SELECT RAISE(ABORT, 'attempt input and business identity are immutable'); END;

PRAGMA legacy_alter_table = OFF;
`;

/**
 * 第二十六个迁移（P03-8 / F-002）：受控 Git 提交意图与操作回执。
 *
 * 契约依据：docs/p03-8-f002-git-operation-contract.md 与设计 07 §4（提交作为
 * operation：保存预期 HEAD、代码摘要、消息和策略→执行 git→核对新 HEAD/tree→
 * 回执落库）、设计 11 §9（operations 的恢复意图/回执语义）。本迁移只建立
 * 提交意图与回执的持久化边界，不执行 Git；F-003 在事务外执行受控提交，
 * F-004 依据本表意图核对不确定副作用。
 *
 * 结构决策：
 * - 复用既有 Project/Feature/Run/Attempt/RepositoryBinding 身份与复合外键，
 *   不新建第二套项目/仓库表；不建立设计 11 中面向未来的通用 operations 表
 *   （本表即 Git 外部副作用的专用 intent/step/receipt 记录，F-002 范围更窄）；
 * - features 追加 delivery_status 列（设计 02 §交付状态四态），历史 features
 *   行取默认 not_requested；仅以 ADD COLUMN 追加，不重建历史表、不改历史
 *   checksum；
 * - 意图列不可变（触发器 + 应用侧 CAS）；终态后任何 UPDATE 拒绝（迟到结果/
 *   重复收尾不能覆盖权威事实）；INSERT 只允许 pending（未固定意图不能先有终态）；
 * - 未知退出码/耗时保持 NULL；succeeded 的 actual_tree 必须等于固定候选 tree，
 *   no_change 的 actual_commit 必须等于固定 expected_head（行级 CHECK + 应用侧
 *   双重校验）；unknown 不得携带 actual commit/tree；
 * - 大正文/路径不进事件 payload；本表只保存身份级事实与用户明确身份，不保存
 *   凭据、原始 diff 或 Git 输出正文。
 */
const MIGRATION_026_SQL = `
ALTER TABLE features ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'not_requested'
  CONSTRAINT features_delivery_status_enum_check
  CHECK (delivery_status IN ('not_requested', 'pending', 'succeeded', 'failed'));

CREATE TABLE git_operations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT,
  execution_version INTEGER NOT NULL,
  operation_type TEXT NOT NULL,
  repository_binding_id TEXT NOT NULL,
  repo_identity TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  expected_head TEXT NOT NULL,
  candidate_tree TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  verification_refs TEXT NOT NULL,
  approval_refs TEXT NOT NULL,
  message TEXT NOT NULL,
  identity_name TEXT NOT NULL,
  identity_email TEXT NOT NULL,
  delivery_policy_digest TEXT NOT NULL,
  runtime_source TEXT,
  owner_id TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  actual_commit TEXT,
  actual_tree TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  reason_code TEXT,
  receipt TEXT,
  delivery_status TEXT,
  settled_at INTEGER,
  CONSTRAINT git_operations_revision_check CHECK (revision >= 1),
  CONSTRAINT git_operations_version_check CHECK (typeof(execution_version) = 'integer' AND execution_version >= 1),
  CONSTRAINT git_operations_type_check CHECK (operation_type = 'feature_final_commit'),
  CONSTRAINT git_operations_oid_check CHECK (
    (length(expected_head) IN (40, 64) AND expected_head NOT GLOB '*[^0-9a-f]*')
    AND (length(candidate_tree) IN (40, 64) AND candidate_tree NOT GLOB '*[^0-9a-f]*')
    AND (actual_commit IS NULL OR (length(actual_commit) IN (40, 64) AND actual_commit NOT GLOB '*[^0-9a-f]*'))
    AND (actual_tree IS NULL OR (length(actual_tree) IN (40, 64) AND actual_tree NOT GLOB '*[^0-9a-f]*'))
  ),
  CONSTRAINT git_operations_digest_check CHECK (
    length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*'
    AND length(delivery_policy_digest) = 64 AND delivery_policy_digest NOT GLOB '*[^0-9a-f]*'
    AND length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT git_operations_refs_check CHECK (
    json_valid(verification_refs) AND json_type(verification_refs) = 'array'
    AND json_valid(approval_refs) AND json_type(approval_refs) = 'array'
  ),
  CONSTRAINT git_operations_message_check CHECK (length(trim(message)) > 0 AND length(message) <= 16384),
  CONSTRAINT git_operations_identity_check CHECK (length(trim(identity_name)) > 0 AND length(trim(identity_email)) > 0),
  CONSTRAINT git_operations_runtime_check CHECK (runtime_source IS NULL OR (json_valid(runtime_source) AND json_type(runtime_source) = 'object')),
  CONSTRAINT git_operations_status_check CHECK (status IN ('pending', 'succeeded', 'no_change', 'failed', 'unknown')),
  CONSTRAINT git_operations_delivery_status_check CHECK (delivery_status IS NULL OR delivery_status IN ('not_requested', 'pending', 'succeeded', 'failed')),
  CONSTRAINT git_operations_exit_check CHECK (exit_code IS NULL OR (typeof(exit_code) = 'integer' AND exit_code >= 0)),
  CONSTRAINT git_operations_duration_check CHECK (duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0)),
  CONSTRAINT git_operations_reason_check CHECK (reason_code IS NULL OR reason_code GLOB '[a-z]*' AND length(reason_code) <= 64 AND reason_code NOT GLOB '*[^a-z0-9_]*'),
  CONSTRAINT git_operations_receipt_check CHECK (receipt IS NULL OR (json_valid(receipt) AND json_type(receipt) = 'object')),
  CONSTRAINT git_operations_times_check CHECK (
    typeof(created_at) = 'integer' AND created_at >= 0
    AND typeof(updated_at) = 'integer' AND updated_at >= 0
    AND (settled_at IS NULL OR (typeof(settled_at) = 'integer' AND settled_at >= 0))
  ),
  CONSTRAINT git_operations_terminal_shape_check CHECK (
    (status = 'pending' AND actual_commit IS NULL AND actual_tree IS NULL AND exit_code IS NULL
      AND duration_ms IS NULL AND reason_code IS NULL AND receipt IS NULL
      AND delivery_status IS NULL AND settled_at IS NULL)
    OR (status = 'succeeded' AND actual_commit IS NOT NULL AND actual_tree = candidate_tree
      AND receipt IS NOT NULL AND delivery_status = 'succeeded' AND settled_at IS NOT NULL)
    OR (status = 'no_change' AND actual_commit = expected_head AND actual_tree IS NOT NULL
      AND receipt IS NOT NULL AND delivery_status = 'succeeded' AND settled_at IS NOT NULL)
    OR (status = 'failed' AND receipt IS NOT NULL AND delivery_status = 'failed' AND settled_at IS NOT NULL)
    OR (status = 'unknown' AND actual_commit IS NULL AND actual_tree IS NULL
      AND receipt IS NOT NULL AND delivery_status = 'pending' AND settled_at IS NOT NULL)
  ),
  CONSTRAINT git_operations_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT git_operations_binding_fk FOREIGN KEY (repository_binding_id) REFERENCES repository_bindings (id) ON DELETE RESTRICT,
  CONSTRAINT git_operations_feature_fk FOREIGN KEY (project_id, feature_id) REFERENCES features (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT git_operations_run_fk FOREIGN KEY (feature_id, run_id) REFERENCES runs (feature_id, id) ON DELETE RESTRICT,
  CONSTRAINT git_operations_attempt_fk FOREIGN KEY (project_id, attempt_id) REFERENCES attempts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT git_operations_binding_same_project_fk FOREIGN KEY (project_id, repository_binding_id) REFERENCES repository_bindings (project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX git_operations_project_id_id_unique ON git_operations (project_id, id);
CREATE INDEX git_operations_project_feature_status_index ON git_operations (project_id, feature_id, status);
CREATE INDEX git_operations_project_run_index ON git_operations (project_id, run_id);
CREATE INDEX git_operations_project_intent_index ON git_operations (project_id, intent_digest);

CREATE TRIGGER git_operations_insert_pending BEFORE INSERT ON git_operations
WHEN NEW.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'git operation must start pending'); END;

CREATE TRIGGER git_operations_attempt_identity_check BEFORE INSERT ON git_operations
WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM attempts
  WHERE attempts.id = NEW.attempt_id AND attempts.project_id = NEW.project_id
    AND attempts.feature_id = NEW.feature_id AND attempts.run_id = NEW.run_id
    AND attempts.execution_version = NEW.execution_version
)
BEGIN SELECT RAISE(ABORT, 'git operation attempt identity mismatch'); END;

CREATE TRIGGER git_operations_intent_immutable BEFORE UPDATE ON git_operations
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.feature_id IS NOT OLD.feature_id OR NEW.run_id IS NOT OLD.run_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.execution_version IS NOT OLD.execution_version
  OR NEW.operation_type IS NOT OLD.operation_type
  OR NEW.repository_binding_id IS NOT OLD.repository_binding_id
  OR NEW.repo_identity IS NOT OLD.repo_identity OR NEW.worktree_path IS NOT OLD.worktree_path
  OR NEW.expected_head IS NOT OLD.expected_head OR NEW.candidate_tree IS NOT OLD.candidate_tree
  OR NEW.code_digest IS NOT OLD.code_digest
  OR NEW.verification_refs IS NOT OLD.verification_refs
  OR NEW.approval_refs IS NOT OLD.approval_refs
  OR NEW.message IS NOT OLD.message
  OR NEW.identity_name IS NOT OLD.identity_name OR NEW.identity_email IS NOT OLD.identity_email
  OR NEW.delivery_policy_digest IS NOT OLD.delivery_policy_digest
  OR NEW.runtime_source IS NOT OLD.runtime_source
  OR NEW.owner_id IS NOT OLD.owner_id OR NEW.host_instance_id IS NOT OLD.host_instance_id
  OR NEW.intent_digest IS NOT OLD.intent_digest
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'git operation intent is immutable'); END;

CREATE TRIGGER git_operations_terminal_immutable BEFORE UPDATE ON git_operations
WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'git operation is terminal'); END;
`;

/**
 * P03-9 / F-001 Task 边界暂停意图（迁移 v27）。
 *
 * 仅追加两列，复用既有 status/reason/revision：
 * - pause_requested_at 记录用户显式暂停意图的持久时刻（NULL 表示未请求）；
 *   意图在活动 Attempt 收尾后仍保留，避免验证/审批路径把 Run 自动恢复 running；
 * - 不改写既有 CHECK/索引/触发器，不清预算、不改 deadline、不删除代码；
 * - 历史迁移 checksum 不变；空库与前序 v26 库均按顺序应用本迁移。
 */
const MIGRATION_027_SQL = `
ALTER TABLE execution_batches ADD COLUMN pause_requested_at INTEGER
  CONSTRAINT execution_batches_pause_requested_at_non_negative_check
  CHECK (pause_requested_at IS NULL OR (typeof(pause_requested_at) = 'integer' AND pause_requested_at >= 1));

ALTER TABLE runs ADD COLUMN pause_requested_at INTEGER
  CONSTRAINT runs_pause_requested_at_non_negative_check
  CHECK (pause_requested_at IS NULL OR (typeof(pause_requested_at) = 'integer' AND pause_requested_at >= 1));
`;


/**
 * P03-9 / F-002 Run/Batch 取消意图的持久停止 operation（迁移 v28）。
 *
 * 取消命令在短事务内把目标置为 cancelling（有活动执行/占用）或 cancelled
 * （无活动且占用确认安全），并关联一条本表 operation。operation 的身份
 * （project/command/target/run/batch/reason/created_at）不可变；status 只允许
 * stopping → stopped/uncertain。partial unique index 保证同一目标至多一条活动
 * operation，避免重复取消创建第二个停止身份。
 *
 * 不新增业务表或改写既有表/索引/CHECK；历史迁移 checksum 不变。
 */
const MIGRATION_028_SQL = `
CREATE TABLE execution_stop_operations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  run_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  settled_at INTEGER,
  CONSTRAINT execution_stop_operations_revision_check CHECK (revision >= 1),
  CONSTRAINT execution_stop_operations_target_kind_check CHECK (target_kind IN ('run','batch')),
  CONSTRAINT execution_stop_operations_status_check CHECK (status IN ('stopping','stopped','uncertain')),
  CONSTRAINT execution_stop_operations_reason_check CHECK (reason = 'user_cancel'),
  CONSTRAINT execution_stop_operations_target_shape_check CHECK (
    (target_kind = 'run' AND run_id = target_id) OR (target_kind = 'batch' AND run_id IS NULL)
  ),
  CONSTRAINT execution_stop_operations_times_check CHECK (
    typeof(created_at) = 'integer' AND created_at >= 1
    AND typeof(updated_at) = 'integer' AND updated_at >= 1
    AND typeof(requested_at) = 'integer' AND requested_at >= 1
    AND (settled_at IS NULL OR (typeof(settled_at) = 'integer' AND settled_at >= requested_at))
  ),
  CONSTRAINT execution_stop_operations_command_check CHECK (length(command_id) > 0 AND length(command_id) <= 128),
  CONSTRAINT execution_stop_operations_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT execution_stop_operations_batch_fk FOREIGN KEY (project_id, batch_id) REFERENCES execution_batches (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT execution_stop_operations_run_fk FOREIGN KEY (project_id, run_id) REFERENCES runs (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX execution_stop_operations_project_id_id_unique ON execution_stop_operations (project_id, id);
CREATE UNIQUE INDEX execution_stop_operations_project_command_unique ON execution_stop_operations (project_id, command_id);
CREATE UNIQUE INDEX execution_stop_operations_active_target_unique ON execution_stop_operations (project_id, target_kind, target_id)
  WHERE status IN ('stopping', 'uncertain');
CREATE INDEX execution_stop_operations_target_index ON execution_stop_operations (project_id, target_kind, target_id, requested_at);
CREATE TRIGGER execution_stop_operations_identity_immutable BEFORE UPDATE ON execution_stop_operations
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.command_id IS NOT OLD.command_id OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.target_id IS NOT OLD.target_id OR NEW.batch_id IS NOT OLD.batch_id
  OR NEW.run_id IS NOT OLD.run_id OR NEW.reason IS NOT OLD.reason
  OR NEW.requested_at IS NOT OLD.requested_at
BEGIN SELECT RAISE(ABORT, 'execution stop operation identity is immutable'); END;
`;

/**
 * P03-9 / F-003 停止证据关联（迁移 v29）。
 *
 * 取消意图/停止 operation 已在 v28 持久化；本迁移只追加证据引用与核验结果列，
 * 供停止控制在同一 operation 上 CAS 写入 stopped/uncertain、证据 Artifact、
 * 实际强制停止情况与核验时刻。既有表/索引/触发器/CHECK 与历史 checksum 不变。
 */
const MIGRATION_029_SQL = `
ALTER TABLE execution_stop_operations ADD COLUMN evidence_ref TEXT
  CONSTRAINT execution_stop_operations_evidence_ref_check
  CHECK (evidence_ref IS NULL OR (length(evidence_ref) > 0 AND length(evidence_ref) <= 128));

ALTER TABLE execution_stop_operations ADD COLUMN stop_confirmed INTEGER
  CONSTRAINT execution_stop_operations_stop_confirmed_check
  CHECK (stop_confirmed IS NULL OR stop_confirmed IN (0, 1));

ALTER TABLE execution_stop_operations ADD COLUMN forced INTEGER
  CONSTRAINT execution_stop_operations_forced_check
  CHECK (forced IS NULL OR forced IN (0, 1));

ALTER TABLE execution_stop_operations ADD COLUMN checked_at INTEGER
  CONSTRAINT execution_stop_operations_checked_at_check
  CHECK (checked_at IS NULL OR (typeof(checked_at) = 'integer' AND checked_at >= 1));
`;

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
  {
    version: 14,
    sql: MIGRATION_014_SQL,
    checksum: sha256Hex(MIGRATION_014_SQL),
  },
  {
    version: 15,
    sql: MIGRATION_015_SQL,
    checksum: sha256Hex(MIGRATION_015_SQL),
  },
  {
    version: 16,
    sql: MIGRATION_016_SQL,
    checksum: sha256Hex(MIGRATION_016_SQL),
  },
  { version: 17, sql: MIGRATION_017_SQL, checksum: sha256Hex(MIGRATION_017_SQL) },
  { version: 18, sql: MIGRATION_018_SQL, checksum: sha256Hex(MIGRATION_018_SQL) },
  { version: 19, sql: MIGRATION_019_SQL, checksum: sha256Hex(MIGRATION_019_SQL) },
  { version: 20, sql: MIGRATION_020_SQL, checksum: sha256Hex(MIGRATION_020_SQL) },
  { version: 21, sql: MIGRATION_021_SQL, checksum: sha256Hex(MIGRATION_021_SQL) },
  { version: 22, sql: MIGRATION_022_SQL, checksum: sha256Hex(MIGRATION_022_SQL) },
  { version: 23, sql: MIGRATION_023_SQL, checksum: sha256Hex(MIGRATION_023_SQL) },
  { version: 24, sql: MIGRATION_024_SQL, checksum: sha256Hex(MIGRATION_024_SQL), foreignKeysOff: true },
  { version: 25, sql: MIGRATION_025_SQL, checksum: sha256Hex(MIGRATION_025_SQL), foreignKeysOff: true },
  { version: 26, sql: MIGRATION_026_SQL, checksum: sha256Hex(MIGRATION_026_SQL) },
  { version: 27, sql: MIGRATION_027_SQL, checksum: sha256Hex(MIGRATION_027_SQL) },
  { version: 28, sql: MIGRATION_028_SQL, checksum: sha256Hex(MIGRATION_028_SQL) },
  { version: 29, sql: MIGRATION_029_SQL, checksum: sha256Hex(MIGRATION_029_SQL) },
];
