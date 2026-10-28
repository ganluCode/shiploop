/**
 * F-003 Drizzle SQLite Schema（adapters 层；drizzle-orm 只允许在本层被引用，
 * 见 scripts/check-boundaries.ts 与 test/modules/engineering/typescript-build.test.ts）。
 *
 * 设计依据：core-design/03 §1-2、core-design/11 §3（projects/repository_bindings/
 * global_settings/project_settings）、§8（artifacts，本 Feature 子集）、§9（schema_migrations）。
 *
 * 本 Feature 仅建立 P01-2 存储闭环所需的最小六表；phases/features/tasks/runs/
 * attempts/sessions/chat 等后续表随对应功能以新迁移版本增加，不在本 Schema 出现。
 * P01-3 / F-006 起加入 state_events（迁移 v2），P02-2 / F-006 起加入
 * command_receipts（迁移 v3，见下方表注释）；P02-3 / F-007 起加入基线作用域
 * 四表（迁移 v4，见下方表注释）；P05-2 / F-001 起加入 Feature DAG 的
 * feature_dependencies（迁移 v37）；P03-3 / F-002 起加入单 Feature 执行域三表
 * execution_batches/runs/batch_budget_revisions（迁移 v9，见下方表注释）。
 *
 * 与手写迁移 DDL（./migrations.ts）的一致性由 test/modules/storage/sqlite/sqlite-schema-migrations.test.ts
 * 经真实 SQLite pragma 与 getTableConfig 交叉核对；两处必须同步演进。
 *
 * 字段说明（本 Feature 范围内的边界决策）：
 * - projects.description：设计 11 §3 字段字典未列，按 F-002 契约补充的可选列（可空，
 *   不参与 ID 或物理路径推导），依据记录于 ports/state-store.ts 字段注释；
 * - projects.repository_binding_id → repository_bindings.id 为跨表互引用（binding 的
 *   project_id 又指回 projects）。projects ↔ repository_bindings 相互引用会形成类型层面的
 *   推断环，因此 references 回调显式标注 SQLiteColumn 返回类型（回调运行时仍惰性求值，
 *   行为不变）。SQLite 无法在单条普通 FK 中表达“绑定必须属于同一 project_id”，
 *   等价明确约束为：repository_bindings 上的 UNIQUE(project_id,id) 复合唯一键
 *   （设计 11 §1）+ 双向 FK 存在性与 ON DELETE RESTRICT，另加 F-008 补齐的
 *   同项目复合外键 projects(id, repository_binding_id) → repository_bindings(project_id,
 *   id)：repository_binding_id 非空时绑定必须属于本项目，使绕过端口校验的直接 SQL
 *   也无法建立跨项目引用（见下方表级配置）；端口写入路径仍在事务内原子校验，
 *   本 DDL 不放宽；
 * - artifacts 不持久化 retention_class（设计 11 列为必填但取值无设计结论，见
 *   ports/artifact-store.ts 头注释，随保留策略设计一并加入）；
 * - artifacts 不建立 source_attempt_id 列：attempts 表属执行域后续迁移，禁止为不
 *   存在的表创建悬空外键；该字段随执行功能迁移增加；
 * - 大正文永不进库：artifacts 只保存索引（expected_hash、content_hash、size_bytes、
 *   受控逻辑 locator、状态与失败原因）；staging 物理位置由后续 PathService 依据授权
 *   数据根 + 稳定 ID/locator 推导（F-010），恢复核对（F-012）依据本表内容定位残留，
 *   因此无需单独的 staging 持久列；
 * - 时间为应用填充的 UTC 毫秒整数（无数据库时间默认）；revision 是 CAS 并发计数，
 *   与 schema_version/payload.schemaVersion 的数据格式版本分开表达；
 * - JSON 列为 TEXT 存储，DDL 以 json_valid（labels 另要求 json_type='array'）做
 *   数据库级合法性底线；完整结构校验仍发生在存储端口（F-002 契约），DDL 不替代。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  /** CAS 并发计数：每次成功写入递增（≥1）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  displayName: text('display_name').notNull(),
  /** 项目生命周期：active→archiving→archived；删除自 archived 起经 deleting。 */
  status: text('status').notNull().default('active'),
  /** 可选说明（F-002 契约补充列）；不参与 ID 或物理路径。 */
  description: text('description'),
  /** 跨项目筛选标签 JSON 数组；默认 []，已按 ports 校验规则规范化。 */
  labels: text('labels').notNull().default('[]'),
  /** 仓库绑定记录；注册流程落地前恒为 NULL（见文件头“同项目绑定”约束说明）。 */
  repositoryBindingId: text('repository_binding_id').references(
    (): SQLiteColumn => repositoryBindings.id,
    { onDelete: 'restrict' },
  ),
}, (table) => [
  check('projects_revision_positive_check', sql`${table.revision} >= 1`),
  check('projects_display_name_not_empty_check', sql`length(${table.displayName}) > 0`),
  check(
    'projects_status_enum_check',
    sql`${table.status} IN ('active', 'archiving', 'archived', 'deleting')`,
  ),
  check(
    'projects_labels_json_array_check',
    sql`json_valid(${table.labels}) AND json_type(${table.labels}) = 'array'`,
  ),
  // F-008 同项目复合外键：(id, repository_binding_id) 命中 repository_bindings 的
  // UNIQUE(project_id,id) 复合唯一键。repository_binding_id 非空时，绑定必须属于
  // 本项目——直接 SQL 的跨项目引用在 DDL 级被拒绝；为 NULL 时复合外键不生效
  // （未绑定项目合法，SQLite 对含 NULL 子列的外键视为满足）。
  foreignKey({
    name: 'projects_repository_binding_same_project_fk',
    columns: [table.id, table.repositoryBindingId],
    foreignColumns: [repositoryBindings.projectId, repositoryBindings.id],
  }).onDelete('restrict'),
]);

export const repositoryBindings = sqliteTable('repository_bindings', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  /** 所属项目；同项目归属与互引用约束见文件头说明。 */
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 仓库规范绝对路径；全库唯一（remote 不作为唯一身份，设计 11 §3）。 */
  canonicalPath: text('canonical_path').notNull(),
  /** Git 公共元数据目录；可空。 */
  gitCommonDir: text('git_common_dir'),
  repoIdentity: text('repo_identity').notNull(),
  /** 仓库绑定自身的并发计数（设计 11 §3）。 */
  bindingRevision: integer('binding_revision').notNull().default(1),
}, (table) => [
  check('repository_bindings_revision_positive_check', sql`${table.revision} >= 1`),
  check(
    'repository_bindings_canonical_path_not_empty_check',
    sql`length(${table.canonicalPath}) > 0`,
  ),
  check(
    'repository_bindings_repo_identity_not_empty_check',
    sql`length(${table.repoIdentity}) > 0`,
  ),
  check(
    'repository_bindings_binding_revision_positive_check',
    sql`${table.bindingRevision} >= 1`,
  ),
  uniqueIndex('repository_bindings_canonical_path_unique').on(table.canonicalPath),
  // 同项目复合外键（设计 11 §1）：供“绑定属于同一项目”的原子校验使用。
  uniqueIndex('repository_bindings_project_id_id_unique').on(table.projectId, table.id),
]);


/** P06-5：重新绑定的不可变旧/新事实；不替代当前 binding，而是保留核验快照。 */
export const repositoryBindingSnapshots = sqliteTable('repository_binding_snapshots', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  bindingId: text('binding_id').notNull().references((): SQLiteColumn => repositoryBindings.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull(),
  bindingRevision: integer('binding_revision').notNull(),
  canonicalPath: text('canonical_path').notNull(),
  gitCommonDir: text('git_common_dir'),
  repoIdentity: text('repo_identity').notNull(),
  capturedAt: integer('captured_at').notNull(),
  changeKind: text('change_kind').notNull(),
}, (table) => [
  check('repository_binding_snapshots_revision_check', sql`${table.revision} >= 1`),
  check('repository_binding_snapshots_binding_revision_check', sql`${table.bindingRevision} >= 1`),
  check('repository_binding_snapshots_path_check', sql`length(${table.canonicalPath}) > 0`),
  check('repository_binding_snapshots_identity_check', sql`length(${table.repoIdentity}) > 0`),
  check('repository_binding_snapshots_kind_check', sql`${table.changeKind} IN ('previous', 'current')`),
  foreignKey({
    name: 'repository_binding_snapshots_binding_same_project_fk',
    columns: [table.projectId, table.bindingId],
    foreignColumns: [repositoryBindings.projectId, repositoryBindings.id],
  }).onDelete('restrict'),
  uniqueIndex('repository_binding_snapshots_binding_revision_unique').on(table.bindingId, table.revision, table.bindingRevision, table.changeKind),
  index('repository_binding_snapshots_project_captured_index').on(table.projectId, table.capturedAt, table.id),
]);

export const globalSettings = sqliteTable('global_settings', {
  /** 全局单例：DDL 限制 id='global'，主键保证仅一条。 */
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** payload 数据格式版本（与 payload.schemaVersion 一致，分开表达）。 */
  schemaVersion: integer('schema_version').notNull(),
  /** 经 F-002 Payload Schema 校验的当前配置 JSON；DDL 仅保证 JSON 合法。 */
  payload: text('payload').notNull(),
}, (table) => [
  check('global_settings_singleton_id_check', sql`${table.id} = 'global'`),
  check('global_settings_revision_positive_check', sql`${table.revision} >= 1`),
  check('global_settings_schema_version_positive_check', sql`${table.schemaVersion} >= 1`),
  check('global_settings_payload_json_check', sql`json_valid(${table.payload})`),
]);

export const projectSettings = sqliteTable('project_settings', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  /** 每项目一条：UNIQUE(project_id) 由下方唯一索引强制。 */
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  payload: text('payload').notNull(),
}, (table) => [
  check('project_settings_revision_positive_check', sql`${table.revision} >= 1`),
  check('project_settings_schema_version_positive_check', sql`${table.schemaVersion} >= 1`),
  check('project_settings_payload_json_check', sql`json_valid(${table.payload})`),
  uniqueIndex('project_settings_project_id_unique').on(table.projectId),
]);

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  kind: text('kind').notNull(),
  /** pending→ready / pending→failed；ready/failed 为索引级终态（F-002 契约）。 */
  status: text('status').notNull().default('pending'),
  mediaType: text('media_type').notNull(),
  /** 登记时声明的预期 SHA-256（小写 hex 64 位）；发布核验依据。 */
  expectedHash: text('expected_hash').notNull(),
  /** 发布实测 SHA-256；ready 后必填且不可改（由 ready_identity CHECK 保护）。 */
  contentHash: text('content_hash'),
  /** 发布实测字节数；ready 后必填且不可改。 */
  sizeBytes: integer('size_bytes'),
  /** 内容版本（≥1，默认 1）。 */
  version: integer('version').notNull().default(1),
  /** 受控逻辑位置（POSIX 相对）；物理路径由授权数据根推导，不存任意用户绝对路径。 */
  storageLocator: text('storage_locator').notNull(),
  /** failed 时保留的原因与阶段证据；其余状态为 NULL。 */
  failureReason: text('failure_reason'),
}, (table) => [
  check('artifacts_revision_positive_check', sql`${table.revision} >= 1`),
  check('artifacts_kind_not_empty_check', sql`length(${table.kind}) > 0`),
  check('artifacts_status_enum_check', sql`${table.status} IN ('pending', 'ready', 'failed')`),
  check('artifacts_media_type_not_empty_check', sql`length(${table.mediaType}) > 0`),
  check(
    'artifacts_expected_hash_sha256_check',
    sql`length(${table.expectedHash}) = 64 AND ${table.expectedHash} NOT GLOB '*[^0-9a-f]*'`,
  ),
  check(
    'artifacts_content_hash_sha256_check',
    sql`${table.contentHash} IS NULL OR (length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*')`,
  ),
  check(
    'artifacts_size_bytes_non_negative_check',
    sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`,
  ),
  check('artifacts_version_positive_check', sql`${table.version} >= 1`),
  check('artifacts_locator_not_empty_check', sql`length(${table.storageLocator}) > 0`),
  // ready 必须携带实测 hash 与 size（设计 11 §8：ready 需 hash 及 size）。
  check(
    'artifacts_ready_identity_check',
    sql`${table.status} <> 'ready' OR (${table.contentHash} IS NOT NULL AND ${table.sizeBytes} IS NOT NULL)`,
  ),
  uniqueIndex('artifacts_project_id_id_unique').on(table.projectId, table.id),
  index('artifacts_project_id_status_index').on(table.projectId, table.status),
]);

/**
 * P01-3 / F-006 状态事件审计切片（设计 11 §9 的 state_events）。
 *
 * 最小审计切片：只保存 P01-3 已确认的业务状态变化（项目元数据更新等），供后续
 * 界面重连/审计/通知消费；**不实现** SSE 推送与通知投递（Host/通知属后续）。
 *
 * 边界决策（依据 docs/p01-3-application-contract.md §6.3，属显式偏离并请求核对）：
 * - `project_id` 可空：全局配置变更没有适用项目；CHECK 限定「只有 aggregate_type=
 *   'global_settings' 才允许空」。有值时仍受项目外键（ON DELETE RESTRICT）保护。
 * - `payload` 只保存脱敏摘要（如变更字段名），绝不保存字段值、凭据引用或绝对路径；
 *   DDL 以 `json_valid AND json_type='object'` 做数据库级底线，完整结构校验仍在存储层。
 * - `sequence` 为数据库持久全局游标（Host 重启不重置），唯一索引保证单调游标无重复。
 * - run_id/task_id/attempt_id 等执行域关联列随其表在同一迁移中加入，避免为不存在的表
 *   创建悬空外键（本 Feature 明确不建执行表）。
 */
export const stateEvents = sqliteTable('state_events', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  /** 事件为插后不可变：revision 恒为 1（与领域聚合 revision 分开）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 所属项目；全局范围事件为 NULL（见 state_events_project_scope_check）。 */
  projectId: text('project_id').references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  /** 持久全局递增游标；Host 重启不重置。 */
  sequence: integer('sequence').notNull(),
  /** 事件类型，如 'project.metadata_updated'。 */
  eventType: text('event_type').notNull(),
  /** 领域聚合类型（当前写入 project/global_settings/project_settings）；DDL 只要求非空。 */
  aggregateType: text('aggregate_type').notNull(),
  /** 领域聚合标识（全局为 'global'）。 */
  aggregateId: text('aggregate_id').notNull(),
  /** 事件对应写入后的聚合并发计数。 */
  aggregateRevision: integer('aggregate_revision').notNull(),
  /** 脱敏结构化摘要（只含字段名/键名/schemaVersion）；不存原值或凭据。 */
  payload: text('payload').notNull(),
  /** Preparation/retain/cleanup events are linked without introducing a second lease system. */
  operationId: text('operation_id'),
  runId: text('run_id'),
  attemptId: text('attempt_id'),
  executionStage: text('execution_stage'),
  /** 发生时间 UTC 毫秒。 */
  occurredAt: integer('occurred_at').notNull(),
}, (table) => [
  check('state_events_revision_positive_check', sql`${table.revision} >= 1`),
  check('state_events_sequence_positive_check', sql`${table.sequence} >= 1`),
  check('state_events_event_type_not_empty_check', sql`length(${table.eventType}) > 0`),
  check('state_events_aggregate_id_not_empty_check', sql`length(${table.aggregateId}) > 0`),
  check('state_events_aggregate_revision_positive_check', sql`${table.aggregateRevision} >= 1`),
  check(
    'state_events_payload_json_object_check',
    sql`json_valid(${table.payload}) AND json_type(${table.payload}) = 'object'`,
  ),
  // 全局配置变更无适用项目；只有 global_settings 允许 project_id 为空。
  check(
    'state_events_project_scope_check',
    sql`(${table.projectId} IS NOT NULL) OR (${table.aggregateType} = 'global_settings')`,
  ),
  uniqueIndex('state_events_sequence_unique').on(table.sequence),
]);

/**
 * P02-2 / F-006 幂等命令回执表（docs/p02-2-commands-events-contract.md §10）。
 *
 * 边界决策：
 * - `project_id` 可空 + scope CHECK（仅 registration/global 允许 NULL，project
 *   scope 必填且有项目 FK ON DELETE RESTRICT）是对设计 11 §9「必填项目 FK」的
 *   显式偏离登记（§15.1，与 v2 state_events 同一先例）；不使用虚构项目 ID；
 * - 不建 operations 表、不加 operation_id 列；本版本全部为同步短事务命令，
 *   status CHECK 只允许 completed/rejected（accepted 仅前向兼容枚举，无持久化
 *   路径）；completed/rejected 的交叉字段约束由 completed/rejected CHECK 强制；
 * - (principal_id, command_id) 复合唯一：同一 commandId 在不同 principal 下
 *   独立；result_ref 全库唯一（不透明随机引用，不是路径/定位符）；
 * - request_digest 为 64 位小写 hex SHA-256（§5.2 冻结算法，服务端重算）；
 * - error_details 为 JSON 对象（仅受控键），完整结构校验仍在存储端口；
 *   result_json 有界（≤16384 字节）由端口写入路径保证，DDL 不替代。
 */
export const commandReceipts = sqliteTable('command_receipts', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  /** 回执为插后不可变：revision 恒为 1（保留共同字段约定）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 可信主体身份（生产固定 local-owner；受限主体仅测试装配）。 */
  principalId: text('principal_id').notNull(),
  /** 幂等键：客户端生成的 UUID v4；与 principal_id 复合唯一。 */
  commandId: text('command_id').notNull(),
  /** 信封 scope 三态：registration/global/project。 */
  scopeKind: text('scope_kind').notNull(),
  /** 仅 project scope 非空（§15.1）；registration/global 恒为 NULL。 */
  projectId: text('project_id').references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  /** §6 命令白名单操作名。 */
  operation: text('operation').notNull(),
  /** §5.2 请求摘要（64 位小写 hex SHA-256）。 */
  requestDigest: text('request_digest').notNull(),
  /** 回执状态：completed/rejected；P02-3 / F-008 起含 accepted（迁移 v5）。 */
  status: text('status').notNull(),
  /** Public asynchronous operation identity; v5 baseline, v6 Work Batch. */
  operationId: text('operation_id'),
  receiptVersion: integer('receipt_version').notNull().default(5),
  baselineOperationId: text('baseline_operation_id').generatedAlwaysAs(
    sql`CASE WHEN receipt_version = 5 THEN operation_id END`, { mode: 'stored' },
  ),
  batchId: text('batch_id'),
  runId: text('run_id'),
  /** P05-1 / F-003（迁移 v36）：planning.start accepted v7 的 planning Task/候选身份；其余恒 NULL。 */
  planningTaskId: text('planning_task_id'),
  candidateId: text('candidate_id'),
  /** completed：有界业务结果 JSON（序列化 ≤ 16384 字节）。 */
  resultJson: text('result_json'),
  /** completed：不透明结果引用（v1.+43 字符 base64url；全库唯一）。 */
  resultRef: text('result_ref'),
  /** rejected：公开错误码。 */
  errorCode: text('error_code'),
  /** rejected：脱敏固定文案。 */
  errorMessage: text('error_message'),
  /** rejected：JSON 对象（仅受控键）；可空。 */
  errorDetails: text('error_details'),
  /** 信封 issuedAt（UTC 毫秒）。 */
  issuedAt: integer('issued_at').notNull(),
  /** 提交完成时刻（UTC 毫秒）。 */
  completedAt: integer('completed_at').notNull(),
}, (table) => [
  check(
    'command_receipts_scope_check',
    sql`(${table.scopeKind} = 'project' AND ${table.projectId} IS NOT NULL) OR (${table.scopeKind} IN ('registration','global') AND ${table.projectId} IS NULL)`,
  ),
  check(
    'command_receipts_status_check',
    sql`${table.status} IN ('completed','rejected','accepted')`,
  ),
  check(
    'command_receipts_completed_check',
    sql`${table.status} <> 'completed' OR (${table.resultJson} IS NOT NULL AND ${table.resultRef} IS NOT NULL AND ${table.errorCode} IS NULL)`,
  ),
  check(
    'command_receipts_rejected_check',
    sql`${table.status} <> 'rejected' OR (${table.errorCode} IS NOT NULL AND ${table.resultJson} IS NULL)`,
  ),
  check(
    'command_receipts_accepted_check',
    sql`${table.status} <> 'accepted' OR (${table.operationId} IS NOT NULL AND ${table.resultJson} IS NULL AND ${table.resultRef} IS NULL AND ${table.errorCode} IS NULL)`,
  ),
  check(
    'command_receipts_association_check',
    sql`(${table.receiptVersion} = 5 AND ${table.batchId} IS NULL AND ${table.runId} IS NULL AND ${table.planningTaskId} IS NULL AND ${table.candidateId} IS NULL) OR (${table.receiptVersion} = 6 AND ${table.operation} = 'execution.start' AND ${table.status} = 'accepted' AND ${table.scopeKind} = 'project' AND ${table.batchId} IS NOT NULL AND ${table.runId} IS NOT NULL AND ${table.operationId} = ${table.batchId} AND ${table.planningTaskId} IS NULL AND ${table.candidateId} IS NULL AND ${table.errorMessage} IS NULL AND ${table.errorDetails} IS NULL) OR (${table.receiptVersion} = 7 AND ${table.operation} = 'planning.start' AND ${table.status} = 'accepted' AND ${table.scopeKind} = 'project' AND ${table.batchId} IS NOT NULL AND ${table.runId} IS NOT NULL AND ${table.planningTaskId} IS NOT NULL AND ${table.candidateId} IS NOT NULL AND ${table.operationId} = ${table.batchId} AND ${table.errorMessage} IS NULL AND ${table.errorDetails} IS NULL)`,
  ),
  check(
    'command_receipts_digest_check',
    sql`length(${table.requestDigest}) = 64 AND ${table.requestDigest} NOT GLOB '*[^0-9a-f]*'`,
  ),
  uniqueIndex('command_receipts_principal_command_unique').on(table.principalId, table.commandId),
  uniqueIndex('command_receipts_result_ref_unique').on(table.resultRef),
  uniqueIndex('command_receipts_operation_id_unique').on(table.operationId),
  index('command_receipts_principal_project_index').on(table.principalId, table.projectId),
  // F-008：accepted 回执的同事务操作存在性由 FK 兜底（延后定义的基线表经
  // 惰性 extra-config 引用，避免模块定义顺序依赖）。
  foreignKey({
    name: 'command_receipts_operation_fk',
    columns: [table.baselineOperationId],
    foreignColumns: [baselineOperations.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'command_receipts_baseline_same_project_fk',
    columns: [table.projectId, table.baselineOperationId],
    foreignColumns: [baselineOperations.projectId, baselineOperations.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'command_receipts_work_batch_fk',
    columns: [table.projectId, table.batchId],
    foreignColumns: [executionBatches.projectId, executionBatches.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'command_receipts_work_run_fk',
    columns: [table.projectId, table.batchId, table.runId],
    foreignColumns: [runs.projectId, runs.batchId, runs.id],
  }).onDelete('restrict'),
  // P05-1 / F-003（迁移 v36）：v7 规划接受回执的候选身份指向同项目规划上下文
  // （planning_contexts 的 (project_id, candidate_id) 唯一索引；惰性引用避免
  // 模块定义顺序依赖）。
  foreignKey({
    name: 'command_receipts_planning_context_fk',
    columns: [table.projectId, table.candidateId],
    foreignColumns: [planningContexts.projectId, planningContexts.candidateId],
  }).onDelete('restrict'),
]);

/**
 * P02-3 / F-007 基线作用域四表（迁移 v4，docs/p02-3-onboarding-contract.md §10）。
 *
 * 边界决策（相对契约 §10 冻结 DDL 的 F-007 补充，已在契约 §10 写回登记）：
 * - baseline_occupancy.process_identity：可恢复进程身份（设计 11
 *   workspace_leases.process_identity 同一语义），供重启恢复核对旧进程；
 * - baseline_occupancy 单例 CHECK（id='global'）：全局单并发占用只有一行；
 * - 同项目复合外键（v1 projects↔repository_bindings 的 F-008 补齐同一先例）：
 *   授权↔绑定、操作↔授权、检查↔操作均要求同项目；检查的输出制品引用指向
 *   artifacts(id)。直接 SQL 的跨项目引用在 DDL 级被拒绝；端口写入路径仍在
 *   事务内原子校验，本 DDL 不放宽；
 * - baseline_authorizations 为不可变授权（insert-only，无端口更新面）；
 *   baseline_check_results 的检查输入快照（argv/cwd/environment/timeout/
 *   required）随种子行保存，结果经一次性 CAS 收尾（revision 1→2），之后
 *   不可覆盖（终态证据不可变）；未产生的退出码为 NULL；
 * - baseline_operations 为操作生命周期（非终态可 CAS 更新；终态不可覆盖）；
 *   大输出正文存受控文件（artifacts 表），不把大输出写进 SQLite。
 */
export const baselineAuthorizations = sqliteTable('baseline_authorizations', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  repositoryBindingId: text('repository_binding_id')
    .notNull()
    .references((): SQLiteColumn => repositoryBindings.id, { onDelete: 'restrict' }),
  /** 无初始 commit 时为 NULL（不猜 main）。 */
  headCommit: text('head_commit'),
  /** 64 位小写 hex（§6.3 工作区内容摘要）。 */
  workingTreeDigest: text('working_tree_digest').notNull(),
  hasUncommittedChanges: integer('has_uncommitted_changes').notNull(),
  /** = plan_digest（§6.2）。 */
  policyRevision: text('policy_revision').notNull(),
  planDigest: text('plan_digest').notNull(),
  /** 规范化检查计划 JSON（有界，端口写入前校验）。 */
  planJson: text('plan_json').notNull(),
  authorizedBy: text('authorized_by').notNull(),
  authorizedAt: integer('authorized_at').notNull(),
}, (table) => [
  check(
    'baseline_authorizations_digest_check',
    sql`length(${table.workingTreeDigest}) = 64 AND length(${table.planDigest}) = 64`,
  ),
  check('baseline_authorizations_plan_json_check', sql`json_valid(${table.planJson})`),
  foreignKey({
    name: 'baseline_authorizations_binding_same_project_fk',
    columns: [table.projectId, table.repositoryBindingId],
    foreignColumns: [repositoryBindings.projectId, repositoryBindings.id],
  }).onDelete('restrict'),
  uniqueIndex('baseline_authorizations_project_id_id_unique').on(table.projectId, table.id),
]);

export const baselineOperations = sqliteTable('baseline_operations', {
  /** = operationId（UUID v4，公开操作身份）。 */
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** CAS 并发计数（§5.5 迟到执行版本以 expectedRevision 拒绝）。 */
  revision: integer('revision').notNull().default(1),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  /** P02-3 仅 'baseline'（预留 'init'，§10）。 */
  kind: text('kind').notNull(),
  /** decline/空集为 NULL（§10）。 */
  authorizationId: text('authorization_id').references(
    (): SQLiteColumn => baselineAuthorizations.id,
    { onDelete: 'restrict' },
  ),
  /** §8.1 操作状态。 */
  status: text('status').notNull(),
  /** §8.3 受控 reason。 */
  reasonCode: text('reason_code'),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
}, (table) => [
  check(
    'baseline_operations_status_check',
    sql`${table.status} IN ('accepted','running','cancelling','completed','cancelled','failed','interrupted','not_run')`,
  ),
  foreignKey({
    name: 'baseline_operations_authorization_same_project_fk',
    columns: [table.projectId, table.authorizationId],
    foreignColumns: [baselineAuthorizations.projectId, baselineAuthorizations.id],
  }).onDelete('restrict'),
  index('baseline_operations_project_index').on(table.projectId, table.id),
  uniqueIndex('baseline_operations_project_id_id_unique').on(table.projectId, table.id),
]);

export const baselineCheckResults = sqliteTable('baseline_check_results', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** 种子行 1；一次性收尾后 2；之后不可再变（终态证据）。 */
  revision: integer('revision').notNull().default(1),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  operationId: text('operation_id')
    .notNull()
    .references((): SQLiteColumn => baselineOperations.id, { onDelete: 'restrict' }),
  checkKey: text('check_key').notNull(),
  /** 命令数组快照（脱敏展示用；发布制品另存 artifacts）。 */
  argvJson: text('argv_json').notNull(),
  cwdRef: text('cwd_ref'),
  environmentRef: text('environment_ref'),
  timeoutMs: integer('timeout_ms').notNull(),
  required: integer('required').notNull(),
  /** §8.1 检查业务状态。 */
  status: text('status').notNull(),
  reasonCode: text('reason_code'),
  /** 未产生的退出码为 NULL。 */
  exitCode: integer('exit_code'),
  signal: text('signal'),
  timedOut: integer('timed_out').notNull().default(0),
  outputArtifactId: text('output_artifact_id').references((): SQLiteColumn => artifacts.id, {
    onDelete: 'restrict',
  }),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
}, (table) => [
  check(
    'baseline_check_results_status_check',
    sql`${table.status} IN ('passed','failed','error','inconclusive','not_run')`,
  ),
  check(
    'baseline_check_results_argv_json_check',
    sql`json_valid(${table.argvJson}) AND json_type(${table.argvJson}) = 'array'`,
  ),
  check('baseline_check_results_timeout_positive_check', sql`${table.timeoutMs} >= 1`),
  check('baseline_check_results_revision_positive_check', sql`${table.revision} >= 1`),
  foreignKey({
    name: 'baseline_check_results_operation_same_project_fk',
    columns: [table.projectId, table.operationId],
    foreignColumns: [baselineOperations.projectId, baselineOperations.id],
  }).onDelete('restrict'),
  uniqueIndex('baseline_check_results_operation_check_unique').on(table.operationId, table.checkKey),
]);

export const baselineOccupancy = sqliteTable('baseline_occupancy', {
  /** 固定字面量 'global'（单例 CHECK）。 */
  id: text('id').primaryKey(),
  holderOperationId: text('holder_operation_id').references(
    (): SQLiteColumn => baselineOperations.id,
    { onDelete: 'restrict' },
  ),
  acquiredAt: integer('acquired_at'),
  heartbeatAt: integer('heartbeat_at'),
  /** 可恢复进程身份（JSON 对象可空；§13 全局单并发占用的运行时证据）。 */
  processIdentity: text('process_identity'),
}, (table) => [
  check('baseline_occupancy_singleton_id_check', sql`${table.id} = 'global'`),
  check(
    'baseline_occupancy_process_identity_json_check',
    sql`${table.processIdentity} IS NULL OR (json_valid(${table.processIdentity}) AND json_type(${table.processIdentity}) = 'object')`,
  ),
]);

/**
 * P03-1 / F-002 计划结构四表（迁移 v6，docs/p03-1-plan-import-contract.md 与设计 11 §4）。
 *
 * 边界与先例（与迁移 v6 同源，一致性由 test/modules/storage/sqlite/sqlite-schema-migrations.test.ts 交叉核对）：
 * - phases/features/tasks 均有同项目复合唯一键 (project_id,id)：既是复合外键目标，
 *   也供跨项目引用在 DDL 级拒绝（features→phases、tasks→features 与
 *   task_dependencies→tasks 的同 Feature 复合外键）；
 * - task_dependencies 两端必须同 Feature（UNIQUE(feature_id,task_id,depends_on_id)
 *   + 自依赖 CHECK + 两个同 Feature 复合外键）；环检测不在 DDL 层，由存储原语在
 *   事务内 DFS 校验；
 * - requirements 多引用形态（JSON 数组 requirements_refs）按 P03-1 契约 §9.1 由本
 *   迁移定案，与 F-001 纯校验的多引用形态一致；acceptance/execution_config 为
 *   JSON 对象；labels/source_refs 为 JSON 数组，默认 '[]' 且不继承父级；
 * - 状态枚举冻结设计 02/11 的完整生命周期（创建路径仅写入 open/draft/pending，
 *   其余取值随对应功能迁移使用）；config_source 仅非空约束，取值由 F-003 定案；
 * - 不建 feature_dependencies/execution_batches/runs/attempts/approvals 等表；
 *   tasks 的执行域计数列（attempt_counter/code_attempts_used）由 P03-3 / F-006
 *   迁移 v11 追加，kind 等其余执行域列仍随后续功能迁移增加。
 */
export const phases = sqliteTable('phases', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  /** 所属项目；同项目归属由复合外键与端口写入路径共同保证。 */
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  /** CAS 并发计数（≥1，每次成功写入递增）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  title: text('title').notNull(),
  /** 阶段生命周期：open/closed/archived（设计 02 §1；创建恒为 open）。 */
  status: text('status').notNull().default('open'),
  /** 可选说明（Markdown；省略/全空白归一 null）。 */
  description: text('description'),
  /** 阶段标签 JSON 数组；默认 []，不向 Feature/Task 继承。 */
  labels: text('labels').notNull().default('[]'),
  /** 阶段交付状态；批准不改变 Phase 生命周期 status。 */
  deliveryStatus: text('delivery_status').notNull().default('not_requested'),
  /** 当前生效的人工批准记录引用；批准/失效由 Core 原子更新。 */
  deliveryApprovalId: text('delivery_approval_id'),
  deliveryCandidateId: text('delivery_candidate_id'),
  deliveryBatchId: text('delivery_batch_id'),
  deliverySummaryDigest: text('delivery_summary_digest'),
}, (table) => [
  check('phases_revision_positive_check', sql`${table.revision} >= 1`),
  check('phases_title_not_empty_check', sql`length(${table.title}) > 0`),
  check('phases_status_enum_check', sql`${table.status} IN ('open', 'closed', 'archived')`),
  check('phases_delivery_status_enum_check', sql`${table.deliveryStatus} IN ('not_requested', 'awaiting_approval', 'approved', 'invalidated')`),
  check('phases_delivery_summary_digest_check', sql`${table.deliverySummaryDigest} IS NULL OR (length(${table.deliverySummaryDigest}) = 64 AND ${table.deliverySummaryDigest} NOT GLOB '*[^0-9a-f]*')`),
  check(
    'phases_labels_json_array_check',
    sql`json_valid(${table.labels}) AND json_type(${table.labels}) = 'array'`,
  ),
  // 同项目复合外键目标（与 repository_bindings 同一先例）。
  uniqueIndex('phases_project_id_id_unique').on(table.projectId, table.id),
]);

export const features = sqliteTable('features', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  /** CAS 并发计数（计划导入/编辑共用 Feature 聚合 revision，P03-1 契约 §6.2）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 所属阶段；必须同项目（复合外键）。 */
  phaseId: text('phase_id')
    .notNull()
    .references((): SQLiteColumn => phases.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  /** Feature 业务状态：创建恒为 draft，其余取值随执行/审批功能使用。 */
  status: text('status').notNull().default('draft'),
  /** 当前计划审批状态（最小集：draft/pending_approval/approved，设计 11 §4）。 */
  planStatus: text('plan_status').notNull().default('draft'),
  description: text('description'),
  labels: text('labels').notNull().default('[]'),
  /** 输入来源制品引用 JSON 数组（身份级 {artifactId,contentHash?}）。 */
  sourceRefs: text('source_refs').notNull().default('[]'),
  /** 当前计划业务摘要（F-001 规范化 SHA-256；不是 CAS 依据）。 */
  planDigest: text('plan_digest'),
  /** P03-8 / F-002：交付状态（设计 02 四态；提交回执同事务更新，不改变计划 revision）。 */
  deliveryStatus: text('delivery_status').notNull().default('not_requested'),
}, (table) => [
  check('features_revision_positive_check', sql`${table.revision} >= 1`),
  check('features_title_not_empty_check', sql`length(${table.title}) > 0`),
  check(
    'features_status_enum_check',
    sql`${table.status} IN ('draft', 'ready', 'running', 'awaiting_approval', 'completed', 'partial', 'failed')`,
  ),
  check(
    'features_plan_status_enum_check',
    sql`${table.planStatus} IN ('draft', 'pending_approval', 'approved')`,
  ),
  check(
    'features_labels_json_array_check',
    sql`json_valid(${table.labels}) AND json_type(${table.labels}) = 'array'`,
  ),
  check(
    'features_source_refs_json_array_check',
    sql`json_valid(${table.sourceRefs}) AND json_type(${table.sourceRefs}) = 'array'`,
  ),
  check(
    'features_plan_digest_sha256_check',
    sql`${table.planDigest} IS NULL OR (length(${table.planDigest}) = 64 AND ${table.planDigest} NOT GLOB '*[^0-9a-f]*')`,
  ),
  check(
    'features_delivery_status_enum_check',
    sql`${table.deliveryStatus} IN ('not_requested', 'pending', 'succeeded', 'failed')`,
  ),
  // 同项目复合外键：跨项目 Phase 引用在 DDL 级被拒绝。
  foreignKey({
    name: 'features_phase_same_project_fk',
    columns: [table.projectId, table.phaseId],
    foreignColumns: [phases.projectId, phases.id],
  }).onDelete('restrict'),
  uniqueIndex('features_project_id_id_unique').on(table.projectId, table.id),
  // P03-3 / F-002：同项目同 Phase 复合唯一键（迁移 v9）：供
  // execution_batches(project_id,phase_id,feature_id) 复合外键引用——
  // Batch 的 phase_id 必须是其 Feature 的真实 Phase，直接 SQL 伪造归属被拒绝。
  uniqueIndex('features_project_phase_id_id_unique').on(table.projectId, table.phaseId, table.id),
  index('features_phase_id_status_index').on(table.phaseId, table.status),
]);

export const tasks = sqliteTable('tasks', {
  /** 计划作者指定的稳定 ID（P03-1 契约；Phase/Feature 由应用侧生成 UUID，Task 保留计划内 ID）。 */
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  /** CAS 并发计数（无独立 CAS：计划修订在 Feature 聚合事务内整体替换，契约 §6.2）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 所属 Feature；必须同项目（复合外键）。 */
  featureId: text('feature_id')
    .notNull()
    .references((): SQLiteColumn => features.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  /** Task 持久状态：创建恒为 pending（设计 02 §4 完整枚举）。 */
  status: text('status').notNull().default('pending'),
  /** 任务复杂度（low/medium/high，可空；复用配置复杂度取值）。 */
  complexity: text('complexity'),
  description: text('description'),
  labels: text('labels').notNull().default('[]'),
  /** 结构化验收 {"criteria":[...]}（有序清单；引用/描述不能替代）。 */
  acceptance: text('acceptance').notNull(),
  /** 需求/验收制品引用 JSON 数组（身份级；P03-1 契约 §9.1 多引用形态）。 */
  requirementsRefs: text('requirements_refs').notNull().default('[]'),
  /** Task 可编辑完整策略副本 JSON 对象（创建时复制；完整策略语义由 F-003 应用层校验）。 */
  executionConfig: text('execution_config').notNull(),
  /** 策略来源（project_default/global_default/user_override；F-003 定案，见 application/task-strategy-selection）。 */
  configSource: text('config_source').notNull(),
  /** 来源策略键（仅追踪用途；可空）。 */
  configSourceKey: text('config_source_key'),
  /** P03-3 / F-006（迁移 v11）：Task 总尝试累计计数（含基础设施分类；非负，不随
   *  换 Run/换模型/重开清零；非负与 code ≤ total 由迁移 v11 内联 CHECK 底线保护）。 */
  attemptCounter: integer('attempt_counter').notNull().default(0),
  /** P03-3 / F-006（迁移 v11）：已消耗代码尝试计数（首次代码执行与代码修复；
   *  仅受信 Core 基础设施重分类可退还，成功/取消/失败不退）。 */
  codeAttemptsUsed: integer('code_attempts_used').notNull().default(0),
  /** P03-4: monotonic Task fencing version, advanced only by atomic claiming. */
  executionVersion: integer('execution_version').notNull().default(0),
  kind: text('kind').notNull().default('coding'),
  manualBlock: integer('manual_block').notNull().default(0),
  /** F-008：首次受信通过的时间事实；元数据更新和旧状态重放不可改写。 */
  firstPassedAt: integer('first_passed_at'),
}, (table) => [
  check('tasks_kind_check', sql`${table.kind} IN ('coding', 'planning')`),
  check('tasks_manual_block_check', sql`typeof(${table.manualBlock}) = 'integer' AND ${table.manualBlock} IN (0, 1)`),
  check('tasks_execution_version_non_negative_check', sql`typeof(${table.executionVersion}) = 'integer' AND ${table.executionVersion} >= 0`),
  check('tasks_first_passed_at_positive_check', sql`${table.firstPassedAt} IS NULL OR ${table.firstPassedAt} >= 1`),
  check('tasks_revision_positive_check', sql`${table.revision} >= 1`),
  check('tasks_title_not_empty_check', sql`length(${table.title}) > 0`),
  check(
    'tasks_status_enum_check',
    sql`${table.status} IN ('pending', 'running', 'passed', 'failed', 'skipped', 'cancelled')`,
  ),
  check(
    'tasks_complexity_enum_check',
    sql`${table.complexity} IS NULL OR ${table.complexity} IN ('low', 'medium', 'high')`,
  ),
  check(
    'tasks_labels_json_array_check',
    sql`json_valid(${table.labels}) AND json_type(${table.labels}) = 'array'`,
  ),
  check(
    'tasks_acceptance_json_object_check',
    sql`json_valid(${table.acceptance}) AND json_type(${table.acceptance}) = 'object'`,
  ),
  check(
    'tasks_requirements_refs_json_array_check',
    sql`json_valid(${table.requirementsRefs}) AND json_type(${table.requirementsRefs}) = 'array'`,
  ),
  check(
    'tasks_execution_config_json_object_check',
    sql`json_valid(${table.executionConfig}) AND json_type(${table.executionConfig}) = 'object'`,
  ),
  check('tasks_config_source_not_empty_check', sql`length(${table.configSource}) > 0`),
  // 同项目复合外键：跨项目 Feature 引用在 DDL 级被拒绝。
  foreignKey({
    name: 'tasks_feature_same_project_fk',
    columns: [table.projectId, table.featureId],
    foreignColumns: [features.projectId, features.id],
  }).onDelete('restrict'),
  uniqueIndex('tasks_project_id_id_unique').on(table.projectId, table.id),
  // 同 Feature 复合外键目标（task_dependencies 两端）：id 全局唯一使 (feature_id,id)
  // 唯一前提成立，但 SQLite 复合外键父键需要显式唯一索引。
  uniqueIndex('tasks_feature_id_id_unique').on(table.featureId, table.id),
  index('tasks_feature_id_status_index').on(table.featureId, table.status),
]);

export const taskApprovalItems = sqliteTable('task_approval_items', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  featureId: text('feature_id').notNull(),
  taskId: text('task_id').notNull(),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  responsibleParty: text('responsible_party').notNull(),
  planDigest: text('plan_digest').notNull(),
  codeDigest: text('code_digest'),
  artifactRefs: text('artifact_refs').notNull().default('[]'),
  status: text('status').notNull().default('pending'),
  createdBy: text('created_by').notNull(),
  decision: text('decision'),
  decisionActor: text('decision_actor'),
  decisionReason: text('decision_reason'),
  decisionCodeDigest: text('decision_code_digest'),
  decisionArtifactRefs: text('decision_artifact_refs').notNull().default('[]'),
  decidedAt: integer('decided_at'),
}, (table) => [
  check('task_approval_items_revision_check', sql`${table.revision} >= 1`),
  check('task_approval_items_kind_check', sql`${table.kind} IN ('block', 'approval')`),
  check('task_approval_items_status_check', sql`${table.status} IN ('pending', 'approved', 'rejected', 'unblocked')`),
  check('task_approval_items_decision_check', sql`${table.decision} IS NULL OR ${table.decision} IN ('approve', 'reject', 'unblock')`),
  check('task_approval_items_decision_binding_check', sql`(${table.status} = 'pending' AND ${table.decision} IS NULL AND ${table.decisionActor} IS NULL AND ${table.decidedAt} IS NULL) OR (${table.status} = 'approved' AND ${table.decision} = 'approve' AND ${table.decisionActor} IS NOT NULL AND ${table.decidedAt} IS NOT NULL) OR (${table.status} = 'rejected' AND ${table.decision} = 'reject' AND ${table.decisionActor} IS NOT NULL AND ${table.decidedAt} IS NOT NULL) OR (${table.status} = 'unblocked' AND ${table.decision} = 'unblock' AND ${table.decisionActor} IS NOT NULL AND ${table.decidedAt} IS NOT NULL)`),
  check('task_approval_items_plan_digest_check', sql`length(${table.planDigest}) = 64 AND ${table.planDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('task_approval_items_code_digest_check', sql`${table.codeDigest} IS NULL OR (length(${table.codeDigest}) = 64 AND ${table.codeDigest} NOT GLOB '*[^0-9a-f]*')`),
  check('task_approval_items_decision_code_digest_check', sql`${table.decisionCodeDigest} IS NULL OR (length(${table.decisionCodeDigest}) = 64 AND ${table.decisionCodeDigest} NOT GLOB '*[^0-9a-f]*')`),
  check('task_approval_items_artifacts_check', sql`json_valid(${table.artifactRefs}) AND json_type(${table.artifactRefs}) = 'array' AND json_valid(${table.decisionArtifactRefs}) AND json_type(${table.decisionArtifactRefs}) = 'array'`),
  foreignKey({ name: 'task_approval_items_feature_fk', columns: [table.projectId, table.featureId], foreignColumns: [features.projectId, features.id] }).onDelete('restrict'),
  foreignKey({ name: 'task_approval_items_task_fk', columns: [table.featureId, table.taskId], foreignColumns: [tasks.featureId, tasks.id] }).onDelete('restrict'),
  uniqueIndex('task_approval_items_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('task_approval_items_task_identity_unique').on(table.projectId, table.featureId, table.taskId, table.kind, table.description, table.responsibleParty, table.planDigest, table.codeDigest, table.artifactRefs),
  index('task_approval_items_task_status_index').on(table.projectId, table.taskId, table.status),
]);

export const taskDependencies = sqliteTable('task_dependencies', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  /** 依赖边插后不可变：revision 恒为 1（计划修订在 Feature 聚合事务内整体替换）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  featureId: text('feature_id')
    .notNull()
    .references((): SQLiteColumn => features.id, { onDelete: 'restrict' }),
  /** 依赖方任务（必须属于 featureId 指定的同 Feature 任务）。 */
  taskId: text('task_id')
    .notNull()
    .references((): SQLiteColumn => tasks.id, { onDelete: 'restrict' }),
  /** 前置依赖任务（同 Feature；无自依赖、无重复边、无环）。 */
  dependsOnId: text('depends_on_id')
    .notNull()
    .references((): SQLiteColumn => tasks.id, { onDelete: 'restrict' }),
}, (table) => [
  check('task_dependencies_revision_positive_check', sql`${table.revision} >= 1`),
  // 自依赖拒绝（重复边由唯一索引拒绝；环由存储原语事务内 DFS 校验）。
  check('task_dependencies_no_self_dependency_check', sql`${table.taskId} <> ${table.dependsOnId}`),
  // 同项目复合外键：边声明的项目必须与 Feature 一致。
  foreignKey({
    name: 'task_dependencies_feature_same_project_fk',
    columns: [table.projectId, table.featureId],
    foreignColumns: [features.projectId, features.id],
  }).onDelete('restrict'),
  // 同 Feature 复合外键：跨 Feature 依赖在 DDL 级被拒绝（两端各一条）。
  foreignKey({
    name: 'task_dependencies_task_same_feature_fk',
    columns: [table.featureId, table.taskId],
    foreignColumns: [tasks.featureId, tasks.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'task_dependencies_depends_on_same_feature_fk',
    columns: [table.featureId, table.dependsOnId],
    foreignColumns: [tasks.featureId, tasks.id],
  }).onDelete('restrict'),
  uniqueIndex('task_dependencies_feature_edge_unique').on(
    table.featureId,
    table.taskId,
    table.dependsOnId,
  ),
  index('task_dependencies_feature_depends_on_index').on(table.featureId, table.dependsOnId),
]);

/**
 * P05-2 / F-001 Feature DAG 依赖边（迁移 v37）。
 *
 * 依赖边必须属于同一项目、同一 Phase，且两端都是该 Phase 的 Feature；简单外键
 * 保证实体存在，复合外键防止直接 SQL 伪造项目/Phase 归属。自依赖和重复边由
 * CHECK/唯一索引拒绝；环检测属于依赖写入原语的事务校验，不在 SQLite DDL 中复制。
 * code_baseline_ref 是可选的前置代码集成基线引用，不承载 Batch/Run/Attempt 状态。
 */
export const featureDependencies = sqliteTable('feature_dependencies', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  /** 依赖边插后不可变；计划修订在 Phase/Feature 聚合事务内整体替换。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  phaseId: text('phase_id')
    .notNull()
    .references((): SQLiteColumn => phases.id, { onDelete: 'restrict' }),
  featureId: text('feature_id')
    .notNull()
    .references((): SQLiteColumn => features.id, { onDelete: 'restrict' }),
  dependsOnId: text('depends_on_id')
    .notNull()
    .references((): SQLiteColumn => features.id, { onDelete: 'restrict' }),
  /** 可选的前置代码集成基线引用；业务依赖身份与 Git 集成事实分开保存。 */
  codeBaselineRef: text('code_baseline_ref'),
}, (table) => [
  check('feature_dependencies_revision_positive_check', sql`${table.revision} >= 1`),
  check(
    'feature_dependencies_no_self_dependency_check',
    sql`${table.featureId} <> ${table.dependsOnId}`,
  ),
  foreignKey({
    name: 'feature_dependencies_phase_same_project_fk',
    columns: [table.projectId, table.phaseId],
    foreignColumns: [phases.projectId, phases.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'feature_dependencies_feature_same_phase_fk',
    columns: [table.projectId, table.phaseId, table.featureId],
    foreignColumns: [features.projectId, features.phaseId, features.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'feature_dependencies_depends_on_same_phase_fk',
    columns: [table.projectId, table.phaseId, table.dependsOnId],
    foreignColumns: [features.projectId, features.phaseId, features.id],
  }).onDelete('restrict'),
  uniqueIndex('feature_dependencies_phase_edge_unique').on(
    table.phaseId,
    table.featureId,
    table.dependsOnId,
  ),
  index('feature_dependencies_phase_depends_on_index').on(table.phaseId, table.dependsOnId),
]);

/**
 * 计划批准/拒绝决策记录（P03-2 / F-002 迁移 v7；设计 11 §7 approvals）。
 *
 * subject_type 冻结为 'feature_plan'（subject_id 即 Feature 稳定 ID）；决策绑定
 * subject_digest（当前 planDigest），主体摘要变更后旧决策自然成为历史记录，
 * 不改写旧行。P03-2 只插入已决定（approved/rejected）行；pending/superseded
 * 为设计完整枚举先冻结，后续两段流/superseded 改写随对应功能扩展。
 */
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  /** CAS 并发计数（决策插入恒为 1；后续更新原语随对应功能扩展）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 受审批主体类型（先冻结 feature_plan；后续审批对象类型随对应功能扩展迁移）。 */
  subjectType: text('subject_type').notNull(),
  /** 受审批主体稳定 ID（feature_plan 时为 Feature 稳定 ID；同项目复合外键）。 */
  subjectId: text('subject_id').notNull(),
  /** 批准绑定的主体内容摘要（feature_plan 时为 planDigest；64 位小写 hex）。 */
  subjectDigest: text('subject_digest').notNull(),
  /**
   * 决策绑定的适用检查政策身份摘要（P03-2 / F-003 迁移 v8；64 位小写 hex）。
   * v7 遗留行为 NULL——不等于任何当前身份（核验 fail-closed）。
   */
  checkPolicyDigest: text('check_policy_digest'),
  /** 决策状态（approved/rejected 为 P03-2 写入值；pending/superseded 先冻结枚举）。 */
  status: text('status').notNull().default('pending'),
  /** 决策人（可信主体 principalId；请求不能伪造身份）。 */
  decisionActor: text('decision_actor'),
  /** 适用原因（可选；有界说明）。 */
  reason: text('reason'),
  /** 决策时间 UTC 毫秒（approved/rejected 必填，DDL CHECK 兑现）。 */
  decidedAt: integer('decided_at'),
}, (table) => [
  check('approvals_revision_positive_check', sql`${table.revision} >= 1`),
  check('approvals_subject_type_enum_check', sql`${table.subjectType} = 'feature_plan'`),
  check(
    'approvals_subject_digest_sha256_check',
    sql`length(${table.subjectDigest}) = 64 AND ${table.subjectDigest} NOT GLOB '*[^0-9a-f]*'`,
  ),
  check(
    'approvals_check_policy_digest_sha256_check',
    sql`${table.checkPolicyDigest} IS NULL OR (length(${table.checkPolicyDigest}) = 64 AND ${table.checkPolicyDigest} NOT GLOB '*[^0-9a-f]*')`,
  ),
  check(
    'approvals_status_enum_check',
    sql`${table.status} IN ('pending', 'approved', 'rejected', 'superseded')`,
  ),
  check(
    'approvals_decision_actor_not_empty_check',
    sql`${table.decisionActor} IS NULL OR length(${table.decisionActor}) > 0`,
  ),
  // 已决定形态：approved/rejected 必须携带决策人与决策时间；pending 不得携带。
  check(
    'approvals_decided_shape_check',
    sql`(${table.status} IN ('approved', 'rejected') AND ${table.decisionActor} IS NOT NULL AND ${table.decidedAt} IS NOT NULL) OR (${table.status} = 'pending' AND ${table.decisionActor} IS NULL AND ${table.decidedAt} IS NULL) OR ${table.status} = 'superseded'`,
  ),
  check(
    'approvals_decided_at_non_negative_check',
    sql`${table.decidedAt} IS NULL OR ${table.decidedAt} >= 0`,
  ),
  // 同项目复合外键：跨项目审批主体在 DDL 级被拒绝。
  foreignKey({
    name: 'approvals_feature_same_project_fk',
    columns: [table.projectId, table.subjectId],
    foreignColumns: [features.projectId, features.id],
  }).onDelete('restrict'),
  // 同一主体同一身份（计划摘要 + 检查政策摘要复合，F-003 / v8）至多一条决策
  // （两个竞争决定最多一个生效的 DDL 兑现；检查政策变化后同一 planDigest 可
  // 重新批准当前身份，旧行作为历史证据保留）。
  uniqueIndex('approvals_subject_decision_unique').on(
    table.projectId,
    table.subjectType,
    table.subjectId,
    table.subjectDigest,
    table.checkPolicyDigest,
  ),
  index('approvals_project_subject_index').on(table.projectId, table.subjectId),
]);

/**
 * P03-3 / F-002 单 Feature ExecutionBatch（迁移 v9；core-design/11 §5 与
 * docs/p03-3-execution-schema-contract.md）。
 *
 * 边界与登记决策（相对设计 11 的偏离均已在契约文档登记）：
 * - P03-3 首版为单 Feature 批次：feature_id NOT NULL + scope_snapshot 强制
 *   featureIds 恰含一个成员（CHECK）；phase_id NOT NULL（设计 11 列为可空，
 *   单 Feature 批次恒取所属 Feature 的 Phase，使「同 Phase 活动 Batch 唯一」可
 *   由部分唯一索引保证；多 Feature 跑批属后续路线，届时另行迁移）；
 * - (project_id, phase_id, feature_id) 复合外键 → features(project_id, phase_id,
 *   id)：跨项目引用与 phase 归属伪造在 DDL 级被拒绝；
 * - budget_snapshot/budget_revision/deadline_at 为**当前**批准预算（F-009 修订
 *   在此演进）；初始与历史版本逐行留存于 batch_budget_revisions（含创建时的
 *   初始版本行），不可被当前预算更新覆盖；
 * - 条件唯一：同 Phase 有效活动 Batch 唯一（部分唯一索引；活动集含
 *   paused/interrupted，终态不参与）；
 * - 不可变列（id/created_at/project_id/phase_id/feature_id/scope_snapshot/
 *   config_snapshot）由迁移 v9 触发器禁止 UPDATE 覆盖（Drizzle 无法表达触发器，
 *   一致性由 test/modules/storage/sqlite/sqlite-schema-migrations.test.ts 交叉核对列/索引/外键，
 *   触发器行为由 test/modules/execution/budget/p03-3-execution-schema.test.ts 失败用例覆盖）。
 */
export const executionBatches = sqliteTable('execution_batches', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  /** CAS 并发计数（≥1，每次成功写入递增）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 所属 Phase（= 所属 Feature 的 Phase；复合外键保证一致）。 */
  phaseId: text('phase_id')
    .notNull()
    .references((): SQLiteColumn => phases.id, { onDelete: 'restrict' }),
  /** 单 Feature 范围身份（恰一个 Feature；不可变）。 */
  featureId: text('feature_id')
    .notNull()
    .references((): SQLiteColumn => features.id, { onDelete: 'restrict' }),
  /** 授权范围快照（JSON 对象；featureIds 恰含一个成员由 CHECK 强制；不可变）。 */
  scopeSnapshot: text('scope_snapshot').notNull(),
  /** 输入配置依据（脱敏配置快照 JSON 对象；不可变）。 */
  configSnapshot: text('config_snapshot').notNull(),
  /** 批次生命周期：queued/running/pausing/paused/cancelling/cancelled/succeeded/failed/interrupted。 */
  status: text('status').notNull().default('queued'),
  /** 当前预算审批修订号（≥1；与 batch_budget_revisions.version 对应）。 */
  budgetRevision: integer('budget_revision').notNull().default(1),
  /** 当前批准预算内容（ports/execution-budget schemaVersion=1 契约；DDL 只保 JSON 底线）。 */
  budgetSnapshot: text('budget_snapshot').notNull(),
  /** 累计创建 Run 数（含成功；非负，不随重启清零）。 */
  runsCreated: integer('runs_created').notNull().default(0),
  /** 累计创建 Attempt 数（非负；Attempt 表随 P03-4+ 建立）。 */
  attemptsCreated: integer('attempts_created').notNull().default(0),
  /** 累计预占 Runtime 启动数（非负）。 */
  runtimeStarts: integer('runtime_starts').notNull().default(0),
  /** 连续无进展 Run 数（非负；有有效领域进展才重置）。 */
  noProgressRuns: integer('no_progress_runs').notNull().default(0),
  /** 绝对 UTC 截止时间（epoch 毫秒；暂停不自动延长，延期走预算修订）。 */
  deadlineAt: integer('deadline_at').notNull(),
  /** 原因说明（可空）。 */
  reason: text('reason'),
  /** P03-9 / F-001：用户显式暂停意图的持久时刻（NULL=未请求；迁移 v27）。 */
  pauseRequestedAt: integer('pause_requested_at'),
}, (table) => [
  check('execution_batches_revision_positive_check', sql`${table.revision} >= 1`),
  check(
    'execution_batches_status_enum_check',
    sql`${table.status} IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted')`,
  ),
  check(
    'execution_batches_scope_snapshot_json_check',
    sql`json_valid(${table.scopeSnapshot}) AND json_type(${table.scopeSnapshot}) = 'object'`,
  ),
  // 固定范围至少包含一个 Feature；成员与 Batch 的一致性由 v38 成员表及触发器保证。
  check(
    'execution_batches_scope_members_check',
    sql`json_type(${table.scopeSnapshot}, '$.featureIds') IS 'array' AND json_array_length(${table.scopeSnapshot}, '$.featureIds') >= 1`,
  ),
  check(
    'execution_batches_config_snapshot_json_check',
    sql`json_valid(${table.configSnapshot}) AND json_type(${table.configSnapshot}) = 'object'`,
  ),
  check('execution_batches_budget_revision_positive_check', sql`${table.budgetRevision} >= 1`),
  check(
    'execution_batches_budget_snapshot_json_check',
    sql`json_valid(${table.budgetSnapshot}) AND json_type(${table.budgetSnapshot}) = 'object'`,
  ),
  check('execution_batches_runs_created_non_negative_check', sql`${table.runsCreated} >= 0`),
  check('execution_batches_attempts_created_non_negative_check', sql`${table.attemptsCreated} >= 0`),
  check('execution_batches_runtime_starts_non_negative_check', sql`${table.runtimeStarts} >= 0`),
  check('execution_batches_no_progress_runs_non_negative_check', sql`${table.noProgressRuns} >= 0`),
  check('execution_batches_deadline_at_positive_check', sql`${table.deadlineAt} >= 1`),
  check('execution_batches_pause_requested_at_non_negative_check',
    sql`${table.pauseRequestedAt} IS NULL OR (typeof(${table.pauseRequestedAt}) = 'integer' AND ${table.pauseRequestedAt} >= 1)`),
  // P04 兼容锚点仍必须属于有效 Feature；完整多成员范围由成员表固定。
  foreignKey({
    name: 'execution_batches_feature_same_project_fk',
    columns: [table.projectId, table.featureId],
    foreignColumns: [features.projectId, features.id],
  }).onDelete('restrict'),
  uniqueIndex('execution_batches_project_id_id_unique').on(table.projectId, table.id),
  // 成员表以 (project_id,batch_id,feature_id) 为 Run 的范围目标。
  uniqueIndex('execution_batches_id_feature_id_unique').on(table.id, table.featureId),
  // 同 Phase 有效活动 Batch 唯一（paused/interrupted 不是可绕过的终态）。
  uniqueIndex('execution_batches_active_phase_unique')
    .on(table.phaseId)
    .where(
      sql`${table.status} IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted')`,
    ),
]);

/** P05-3 / F-001：Batch 创建时一次性冻结的成员关系（迁移 v38）。 */
export const executionBatchMembers = sqliteTable('execution_batch_members', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  batchId: text('batch_id').notNull(),
  phaseId: text('phase_id').notNull(),
  featureId: text('feature_id').notNull(),
  memberOrdinal: integer('member_ordinal').notNull(),
}, (table) => [
  check('execution_batch_members_created_at_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0`),
  check('execution_batch_members_ordinal_check', sql`typeof(${table.memberOrdinal}) = 'integer' AND ${table.memberOrdinal} >= 1`),
  foreignKey({
    name: 'execution_batch_members_batch_fk',
    columns: [table.projectId, table.batchId],
    foreignColumns: [executionBatches.projectId, executionBatches.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'execution_batch_members_feature_fk',
    columns: [table.projectId, table.phaseId, table.featureId],
    foreignColumns: [features.projectId, features.phaseId, features.id],
  }).onDelete('restrict'),
  uniqueIndex('execution_batch_members_batch_feature_unique').on(table.projectId, table.batchId, table.featureId),
  uniqueIndex('execution_batch_members_batch_ordinal_unique').on(table.batchId, table.memberOrdinal),
  uniqueIndex('execution_batch_members_project_id_id_unique').on(table.projectId, table.id),
  index('execution_batch_members_batch_index').on(table.projectId, table.batchId, table.memberOrdinal),
]);

/**
 * P03-3 / F-002 Run（迁移 v9；core-design/11 §5 runs）。
 *
 * - 引用同项目 Batch 与 Feature；v38 后 (project_id,batch_id,feature_id) 复合外键
 *   改为引用 execution_batch_members，保证 Run 属于父 Batch 的固定成员；
 * - 保存 purpose、workKey、dispatchOrdinal（派发身份 UNIQUE(batch_id,work_key,
 *   dispatch_ordinal)）、输入快照与配置快照（不可变）、Run 上限（max_attempts_per_run/
 *   run_time_limit_ms，派发时冻结，精确范围归 ports/execution-budget 契约）与时间
 *   依据（started_at 设定后不可改，ended_at 收尾记录）；
 * - 条件唯一：同 Feature 有效活动 Run 唯一（部分唯一索引；活动集含
 *   paused/interrupted）。
 */
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 父 Batch（同项目复合外键；缺失父 Batch 在 DDL 级被拒绝）。 */
  batchId: text('batch_id')
    .notNull()
    .references((): SQLiteColumn => executionBatches.id, { onDelete: 'restrict' }),
  /** 目标 Feature（必须是父 Batch 的同一 Feature）。 */
  featureId: text('feature_id')
    .notNull()
    .references((): SQLiteColumn => features.id, { onDelete: 'restrict' }),
  /** 执行用途（execute/plan 等；非空）。 */
  purpose: text('purpose').notNull(),
  /** 本次输入快照（任务定义/依赖/验收规则 JSON 对象；不可变）。 */
  inputSnapshot: text('input_snapshot').notNull(),
  /** 脱敏配置快照（JSON 对象；不可变）。 */
  configSnapshot: text('config_snapshot').notNull(),
  /** Run 生命周期（与 Batch 同枚举；succeeded/failed/cancelled 为不可重开终态）。 */
  status: text('status').notNull().default('queued'),
  /** 执行范围摘要（64 位小写 hex）。 */
  scopeDigest: text('scope_digest').notNull(),
  /** 逻辑工作去重键（非空；成功后禁止自动再派发）。 */
  workKey: text('work_key').notNull(),
  /** 同工作派发序号（≥1；失败重试递增，不退还计数）。 */
  dispatchOrdinal: integer('dispatch_ordinal').notNull().default(1),
  /** Run 尝试上限（派发时从预算契约冻结；≥1）。 */
  maxAttemptsPerRun: integer('max_attempts_per_run').notNull(),
  /** Run 时间上限毫秒（派发时冻结；≥1）。 */
  runTimeLimitMs: integer('run_time_limit_ms').notNull(),
  /** 累计创建 Attempt 数（非负）。 */
  attemptsCreated: integer('attempts_created').notNull().default(0),
  /** 原因说明（可空）。 */
  reason: text('reason'),
  /** 时间依据：开始时间（UTC 毫秒；设定后不可改，runTimeLimitMs 从此计）。 */
  startedAt: integer('started_at'),
  /** 收尾时间（UTC 毫秒；可空）。 */
  endedAt: integer('ended_at'),
  /** P03-9 / F-001：用户显式暂停意图的持久时刻（NULL=未请求；迁移 v27）。 */
  pauseRequestedAt: integer('pause_requested_at'),
}, (table) => [
  check('runs_revision_positive_check', sql`${table.revision} >= 1`),
  check('runs_purpose_not_empty_check', sql`length(${table.purpose}) > 0`),
  check(
    'runs_input_snapshot_json_check',
    sql`json_valid(${table.inputSnapshot}) AND json_type(${table.inputSnapshot}) = 'object'`,
  ),
  check(
    'runs_config_snapshot_json_check',
    sql`json_valid(${table.configSnapshot}) AND json_type(${table.configSnapshot}) = 'object'`,
  ),
  check(
    'runs_status_enum_check',
    sql`${table.status} IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted')`,
  ),
  check(
    'runs_scope_digest_sha256_check',
    sql`length(${table.scopeDigest}) = 64 AND ${table.scopeDigest} NOT GLOB '*[^0-9a-f]*'`,
  ),
  check('runs_work_key_not_empty_check', sql`length(${table.workKey}) > 0`),
  check('runs_dispatch_ordinal_positive_check', sql`${table.dispatchOrdinal} >= 1`),
  check('runs_max_attempts_per_run_positive_check', sql`${table.maxAttemptsPerRun} >= 1`),
  check('runs_run_time_limit_ms_positive_check', sql`${table.runTimeLimitMs} >= 1`),
  check('runs_attempts_created_non_negative_check', sql`${table.attemptsCreated} >= 0`),
  check('runs_started_at_non_negative_check', sql`${table.startedAt} IS NULL OR ${table.startedAt} >= 0`),
  check('runs_ended_at_non_negative_check', sql`${table.endedAt} IS NULL OR ${table.endedAt} >= 0`),
  check('runs_pause_requested_at_non_negative_check',
    sql`${table.pauseRequestedAt} IS NULL OR (typeof(${table.pauseRequestedAt}) = 'integer' AND ${table.pauseRequestedAt} >= 1)`),
  foreignKey({
    name: 'runs_batch_same_project_fk',
    columns: [table.projectId, table.batchId],
    foreignColumns: [executionBatches.projectId, executionBatches.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'runs_feature_same_project_fk',
    columns: [table.projectId, table.featureId],
    foreignColumns: [features.projectId, features.id],
  }).onDelete('restrict'),
  // Run 必须引用父 Batch 的固定成员，而不是兼容锚点 feature_id。
  foreignKey({
    name: 'runs_batch_member_same_scope_fk',
    columns: [table.projectId, table.batchId, table.featureId],
    foreignColumns: [executionBatchMembers.projectId, executionBatchMembers.batchId, executionBatchMembers.featureId],
  }).onDelete('restrict'),
  // 派发身份唯一（重复派发在 DDL 级被拒绝；失败重试以递增 dispatch_ordinal 表达）。
  uniqueIndex('runs_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('runs_receipt_identity_unique').on(table.projectId, table.batchId, table.id),
  uniqueIndex('runs_feature_id_id_unique').on(table.featureId, table.id),
  uniqueIndex('runs_dispatch_identity_unique').on(table.batchId, table.workKey, table.dispatchOrdinal),
  // 同 Feature 有效活动 Run 唯一（paused/interrupted 不是可绕过的终态）。
  uniqueIndex('runs_active_feature_unique')
    .on(table.featureId)
    .where(
      sql`${table.status} IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted')`,
    ),
  index('runs_batch_id_status_index').on(table.batchId, table.status),
]);

/**
 * P03-9 / F-002 Run/Batch 取消意图的持久停止 operation（迁移 v28）。
 *
 * 身份列不可变；status 只表示停止请求的持久阶段（stopping/stopped/uncertain）。
 * 同一目标至多一条活动 operation（partial unique index），重复取消复用该身份；
 * 取消不修改预算、deadline、累计计数或历史 Attempt。
 */
export const executionStopOperations = sqliteTable('execution_stop_operations', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  commandId: text('command_id').notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: text('target_id').notNull(),
  batchId: text('batch_id').notNull(),
  featureId: text('feature_id'),
  runId: text('run_id'),
  reason: text('reason').notNull(),
  status: text('status').notNull(),
  requestedAt: integer('requested_at').notNull(),
  settledAt: integer('settled_at'),
  // P03-9 / F-003：停止证据引用与核验结果（迁移 v29）。
  evidenceRef: text('evidence_ref'),
  stopConfirmed: integer('stop_confirmed'),
  forced: integer('forced'),
  checkedAt: integer('checked_at'),
}, (table) => [
  check('execution_stop_operations_revision_check', sql`${table.revision} >= 1`),
  check('execution_stop_operations_target_kind_check', sql`${table.targetKind} IN ('run', 'batch', 'feature')`),
  check('execution_stop_operations_status_check', sql`${table.status} IN ('stopping', 'stopped', 'uncertain')`),
  check('execution_stop_operations_reason_check', sql`${table.reason} = 'user_cancel'`),
  check('execution_stop_operations_target_shape_check', sql`
    (${table.targetKind} = 'run' AND ${table.runId} = ${table.targetId} AND ${table.featureId} IS NULL)
    OR (${table.targetKind} = 'batch' AND ${table.runId} IS NULL AND ${table.featureId} IS NULL)
    OR (${table.targetKind} = 'feature' AND ${table.runId} IS NULL AND ${table.featureId} = ${table.targetId})`),
  check('execution_stop_operations_times_check', sql`
    typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 1
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 1
    AND typeof(${table.requestedAt}) = 'integer' AND ${table.requestedAt} >= 1
    AND (${table.settledAt} IS NULL OR (typeof(${table.settledAt}) = 'integer' AND ${table.settledAt} >= ${table.requestedAt}))`),
  check('execution_stop_operations_command_check', sql`length(${table.commandId}) > 0 AND length(${table.commandId}) <= 128`),
  check('execution_stop_operations_evidence_ref_check', sql`${table.evidenceRef} IS NULL OR (length(${table.evidenceRef}) > 0 AND length(${table.evidenceRef}) <= 128)`),
  check('execution_stop_operations_stop_confirmed_check', sql`${table.stopConfirmed} IS NULL OR ${table.stopConfirmed} IN (0, 1)`),
  check('execution_stop_operations_forced_check', sql`${table.forced} IS NULL OR ${table.forced} IN (0, 1)`),
  check('execution_stop_operations_checked_at_check', sql`${table.checkedAt} IS NULL OR (typeof(${table.checkedAt}) = 'integer' AND ${table.checkedAt} >= 1)`),
  foreignKey({ name: 'execution_stop_operations_batch_fk', columns: [table.projectId, table.batchId],
    foreignColumns: [executionBatches.projectId, executionBatches.id] }).onDelete('restrict'),
  foreignKey({ name: 'execution_stop_operations_feature_fk', columns: [table.projectId, table.featureId],
    foreignColumns: [features.projectId, features.id] }).onDelete('restrict'),
  foreignKey({ name: 'execution_stop_operations_run_fk', columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id] }).onDelete('restrict'),
  uniqueIndex('execution_stop_operations_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('execution_stop_operations_project_command_unique').on(table.projectId, table.commandId),
  uniqueIndex('execution_stop_operations_active_target_unique')
    .on(table.projectId, table.targetKind, table.targetId)
    .where(sql`${table.status} IN ('stopping', 'uncertain')`),
  index('execution_stop_operations_target_index')
    .on(table.projectId, table.targetKind, table.targetId, table.requestedAt),
]);

/**
 * P03-3 / F-002 批次预算修订记录（迁移 v9；core-design/11 §5 batch_budget_revisions）。
 *
 * - 关联同项目 Batch（复合外键）；修订身份 UNIQUE(batch_id,version)；保存操作者
 *   （approved_by）、理由（reason）、预算（budget_snapshot）与时间（deadline_at +
 *   created_at）；
 * - 初始（version=1，随 Batch 创建落行）与历史快照为不可变证据行：UPDATE/DELETE
 *   由迁移 v9 触发器拒绝——当前预算更新不覆盖任何历史版本；
 * - 不建计划/配置业务版本表（设计 11 §3/§5 明确不建设范围）。
 */
export const batchBudgetRevisions = sqliteTable('batch_budget_revisions', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  /** 修订记录插后不可变：revision 恒为 1（保留共同字段约定）。 */
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 所属批次（同项目复合外键）。 */
  batchId: text('batch_id')
    .notNull()
    .references((): SQLiteColumn => executionBatches.id, { onDelete: 'restrict' }),
  /** 预算修订身份（≥1；UNIQUE(batch_id,version)）。 */
  version: integer('version').notNull(),
  /** 该版本批准的预算内容（JSON 对象；与 ports/execution-budget 契约同形）。 */
  budgetSnapshot: text('budget_snapshot').notNull(),
  /** 该版本批准的绝对截止时间（UTC 毫秒；≥1）。 */
  deadlineAt: integer('deadline_at').notNull(),
  /** 预算批准人（可信主体；请求不能伪造）。 */
  approvedBy: text('approved_by').notNull(),
  /** 修订理由（非空；增额/延期必须显式说明）。 */
  reason: text('reason').notNull(),
}, (table) => [
  check('batch_budget_revisions_revision_positive_check', sql`${table.revision} >= 1`),
  check('batch_budget_revisions_version_positive_check', sql`${table.version} >= 1`),
  check(
    'batch_budget_revisions_budget_snapshot_json_check',
    sql`json_valid(${table.budgetSnapshot}) AND json_type(${table.budgetSnapshot}) = 'object'`,
  ),
  check('batch_budget_revisions_deadline_at_positive_check', sql`${table.deadlineAt} >= 1`),
  check('batch_budget_revisions_approved_by_not_empty_check', sql`length(${table.approvedBy}) > 0`),
  check('batch_budget_revisions_reason_not_empty_check', sql`length(${table.reason}) > 0`),
  foreignKey({
    name: 'batch_budget_revisions_batch_same_project_fk',
    columns: [table.projectId, table.batchId],
    foreignColumns: [executionBatches.projectId, executionBatches.id],
  }).onDelete('restrict'),
  // 修订身份唯一：同 Batch 同版本至多一条历史快照。
  uniqueIndex('batch_budget_revisions_batch_version_unique').on(table.batchId, table.version),
]);

/**
 * P03-3 / F-006 Task 尝试预占账本（迁移 v11；F-006 验收的实际预算存储）。
 *
 * - 预占身份 UNIQUE(project_id,task_id,attempt_key)：同身份重放去重（不重复调账）、
 *   跨 Run 复用同一 attemptKey 被拒绝（预占身份属于 Task 尝试，不属于 Run）；
 * - classification ∈ {code,infrastructure}：预占恒为 code（首次代码执行与代码修复
 *   都消耗代码额度）；仅受信 Core 重分类原语可单向 code→infrastructure（退还代码
 *   额度但不退总 Attempt）；classified_by 恒 'core'（DDL 拒绝其他主体，客户端/模型
 *   不能自报基础设施错误）；
 * - 本表不是完整 attempts 表：无 number/owner/lease/进程执行字段（P03-4 在同事务
 *   接入真实 Attempt 创建时以本表为同事务预算预占依据）。
 */
export const taskAttemptReservations = sqliteTable('task_attempt_reservations', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 归属 Batch（同项目复合外键；预占时受有效控制状态与预算约束）。 */
  batchId: text('batch_id').notNull(),
  /** 归属 Run（同项目同 Batch 复合外键）。 */
  runId: text('run_id').notNull(),
  /** 预占的 Task（同项目复合外键；必须在 Batch 单 Feature 范围内）。 */
  taskId: text('task_id').notNull(),
  /** 预占身份（受信 Core 生成的稳定键；与未来 attempts 行同事务关联）。 */
  attemptKey: text('attempt_key').notNull(),
  /** 当前记账分类（code→infrastructure 单向重分类）。 */
  classification: text('classification').notNull(),
  /** 受信分类主体（恒 'core'；DDL CHECK 拒绝其他值）。 */
  classifiedBy: text('classified_by').notNull(),
  /** 重分类理由（审计；初始预占为 NULL）。 */
  reason: text('reason'),
}, (table) => [
  check('task_attempt_reservations_revision_positive_check', sql`${table.revision} >= 1`),
  check('task_attempt_reservations_attempt_key_not_empty_check', sql`length(${table.attemptKey}) > 0`),
  check(
    'task_attempt_reservations_classification_enum_check',
    sql`${table.classification} IN ('code', 'infrastructure')`,
  ),
  check('task_attempt_reservations_classified_by_core_check', sql`${table.classifiedBy} = 'core'`),
  foreignKey({
    name: 'task_attempt_reservations_batch_fk',
    columns: [table.projectId, table.batchId],
    foreignColumns: [executionBatches.projectId, executionBatches.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'task_attempt_reservations_run_fk',
    columns: [table.projectId, table.batchId, table.runId],
    foreignColumns: [runs.projectId, runs.batchId, runs.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'task_attempt_reservations_task_fk',
    columns: [table.projectId, table.taskId],
    foreignColumns: [tasks.projectId, tasks.id],
  }).onDelete('restrict'),
  uniqueIndex('task_attempt_reservations_task_attempt_key_unique').on(
    table.projectId,
    table.taskId,
    table.attemptKey,
  ),
  index('task_attempt_reservations_run_id_index').on(table.runId),
]);

/**
 * P03-3 / F-007 Runtime 启动预占账本（迁移 v12；SDK 启动前的受信边界）。
 *
 * - 幂等启动身份 UNIQUE(project_id,start_key)：同身份重放去重只计一次、跨 Run
 *   复用同身份被 DDL 拒绝（启动身份属于其获准 Run，过期身份不可重放）；
 * - 预占一次对应 execution_batches.runtime_starts+1（同事务原子生效）；启动失败
 *   保守保留计数——本表无退额列，也无任何退额原语；
 * - 账本行只是预占证据：无 token/cost 用量列、无 sdk_started/outcome/进程列
 *   （不伪造实际用量或真实 SDK 已启动事实）；Runner/停止管理/会话记录属后续
 *   任务，不在本表预支。
 */
export const runtimeStartReservations = sqliteTable('runtime_start_reservations', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 归属 Batch（同项目复合外键；预占受父 Batch 启动额度与 deadline 约束）。 */
  batchId: text('batch_id').notNull(),
  /** 当前获准 Run（同项目同 Batch 复合外键）。 */
  runId: text('run_id').notNull(),
  /** 启动身份（受信 Core 生成的稳定键；同身份重放只计一次）。 */
  startKey: text('start_key').notNull(),
}, (table) => [
  check('runtime_start_reservations_revision_positive_check', sql`${table.revision} >= 1`),
  check('runtime_start_reservations_start_key_not_empty_check', sql`length(${table.startKey}) > 0`),
  foreignKey({
    name: 'runtime_start_reservations_batch_fk',
    columns: [table.projectId, table.batchId],
    foreignColumns: [executionBatches.projectId, executionBatches.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'runtime_start_reservations_run_fk',
    columns: [table.projectId, table.batchId, table.runId],
    foreignColumns: [runs.projectId, runs.batchId, runs.id],
  }).onDelete('restrict'),
  uniqueIndex('runtime_start_reservations_project_start_key_unique').on(
    table.projectId,
    table.startKey,
  ),
  index('runtime_start_reservations_run_id_index').on(table.runId),
]);

/** F-008：不可变 Run 结果结算账本，DDL 与迁移 v13 保持一致。 */
export const runOutcomeSettlements = sqliteTable('run_outcome_settlements', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  batchId: text('batch_id').notNull(),
  runId: text('run_id').notNull(),
  resultKey: text('result_key').notNull(),
  outcome: text('outcome').notNull(),
  progressType: text('progress_type').notNull(),
  progressTaskId: text('progress_task_id'),
  runEndedAt: integer('run_ended_at').notNull(),
  noProgressRunsAfter: integer('no_progress_runs_after').notNull(),
  reason: text('reason'),
}, (table) => [
  check('run_outcome_settlements_revision_positive_check', sql`${table.revision} >= 1`),
  check('run_outcome_settlements_result_key_not_empty_check', sql`length(${table.resultKey}) > 0`),
  check('run_outcome_settlements_outcome_terminal_check', sql`${table.outcome} IN ('succeeded', 'failed', 'cancelled')`),
  check('run_outcome_settlements_progress_type_enum_check', sql`${table.progressType} IN ('none', 'new_valid_task_passed')`),
  check('run_outcome_settlements_progress_shape_check', sql`
    (${table.progressType} = 'none' AND ${table.progressTaskId} IS NULL)
    OR (${table.progressType} = 'new_valid_task_passed' AND ${table.progressTaskId} IS NOT NULL AND length(${table.progressTaskId}) > 0)
  `),
  check('run_outcome_settlements_run_ended_at_positive_check', sql`${table.runEndedAt} >= 1`),
  check('run_outcome_settlements_no_progress_after_non_negative_check', sql`${table.noProgressRunsAfter} >= 0`),
  foreignKey({
    name: 'run_outcome_settlements_batch_fk',
    columns: [table.projectId, table.batchId],
    foreignColumns: [executionBatches.projectId, executionBatches.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'run_outcome_settlements_run_fk',
    columns: [table.projectId, table.batchId, table.runId],
    foreignColumns: [runs.projectId, runs.batchId, runs.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'run_outcome_settlements_progress_task_fk',
    columns: [table.projectId, table.progressTaskId],
    foreignColumns: [tasks.projectId, tasks.id],
  }).onDelete('restrict'),
  uniqueIndex('run_outcome_settlements_project_result_key_unique').on(table.projectId, table.resultKey),
  uniqueIndex('run_outcome_settlements_progress_evidence_unique').on(table.projectId, table.progressTaskId)
    .where(sql`${table.progressType} = 'new_valid_task_passed'`),
  uniqueIndex('run_outcome_settlements_run_id_unique').on(table.runId),
]);

/** P03-4 F-001: immutable input identity and independently retained resource occupancy. */
export const attempts = sqliteTable('attempts', {
  id: text('id').primaryKey(), createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1), updatedAt: integer('updated_at').notNull(),
  featureId: text('feature_id').notNull(), runId: text('run_id').notNull(), taskId: text('task_id').notNull(),
  number: integer('number').notNull(), ownerId: text('owner_id').notNull(), hostInstanceId: text('host_instance_id').notNull(),
  executionVersion: integer('execution_version').notNull(), leaseUntil: integer('lease_until').notNull(),
  status: text('status').notNull().default('preparing'), executionStage: text('execution_stage').notNull().default('preflight'),
  inputSnapshot: text('input_snapshot').notNull(), inputDigest: text('input_digest').notNull(), inputRef: text('input_ref').notNull(),
  sessionId: text('session_id'), invocationId: text('invocation_id'), codeRef: text('code_ref'), errorKind: text('error_kind'),
  diagnosticRef: text('diagnostic_ref'), startedAt: integer('started_at'), endedAt: integer('ended_at'),
  durationMs: integer('duration_ms'), exitCode: integer('exit_code'), usageSummary: text('usage_summary'),
}, table => [
  check('attempts_revision_check', sql`${table.revision} >= 1`),
  check('attempts_number_check', sql`typeof(${table.number}) = 'integer' AND ${table.number} >= 1`),
  check('attempts_version_check', sql`typeof(${table.executionVersion}) = 'integer' AND ${table.executionVersion} >= 1`),
  check('attempts_owner_check', sql`length(${table.ownerId}) > 0 AND length(${table.hostInstanceId}) > 0`),
  check('attempts_lease_check', sql`typeof(${table.leaseUntil}) = 'integer' AND ${table.leaseUntil} >= 0`),
  check('attempts_status_check', sql`${table.status} IN ('preparing', 'executing', 'verifying', 'succeeded', 'failed', 'cancelled', 'interrupted')`),
  check('attempts_stage_check', sql`${table.executionStage} IN ('preflight', 'runtime', 'verification', 'commit', 'cleanup')`),
  check('attempts_snapshot_check', sql`CASE WHEN json_valid(${table.inputSnapshot}) THEN
    json_type(${table.inputSnapshot}) = 'object' AND json_type(${table.inputSnapshot}, '$.schemaVersion') IS 'integer'
    AND json_extract(${table.inputSnapshot}, '$.schemaVersion') IN (1, 2, 3, 4, 5)
    AND json_extract(${table.inputSnapshot}, '$.projectId') IS ${table.projectId}
    AND json_extract(${table.inputSnapshot}, '$.featureId') IS ${table.featureId}
    AND json_extract(${table.inputSnapshot}, '$.taskId') IS ${table.taskId}
    AND json_extract(${table.inputSnapshot}, '$.digests.snapshotDigest') IS ${table.inputDigest}
    AND json_extract(${table.inputSnapshot}, '$.group.snapshot.artifactId') IS ${table.inputRef} ELSE 0 END`),
  check('attempts_digest_check', sql`length(${table.inputDigest}) = 64 AND ${table.inputDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('attempts_duration_check', sql`${table.durationMs} IS NULL OR (typeof(${table.durationMs}) = 'integer' AND ${table.durationMs} >= 0)`),
  check('attempts_exit_check', sql`${table.exitCode} IS NULL OR typeof(${table.exitCode}) = 'integer'`),
  check('attempts_times_check', sql`(${table.startedAt} IS NULL OR (typeof(${table.startedAt}) = 'integer' AND ${table.startedAt} >= 0))
    AND (${table.endedAt} IS NULL OR (typeof(${table.endedAt}) = 'integer' AND ${table.endedAt} >= 0))
    AND (${table.startedAt} IS NULL OR ${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt})`),
  check('attempts_usage_check', sql`${table.usageSummary} IS NULL OR CASE WHEN json_valid(${table.usageSummary}) THEN
    json_type(${table.usageSummary}) = 'object' AND json_type(${table.usageSummary}, '$.schemaVersion') IS 'integer'
    AND json_extract(${table.usageSummary}, '$.schemaVersion') = 1 ELSE 0 END`),
  foreignKey({ name: 'attempts_feature_fk', columns: [table.projectId, table.featureId], foreignColumns: [features.projectId, features.id] }).onDelete('restrict'),
  foreignKey({ name: 'attempts_run_fk', columns: [table.featureId, table.runId], foreignColumns: [runs.featureId, runs.id] }).onDelete('restrict'),
  foreignKey({ name: 'attempts_task_fk', columns: [table.featureId, table.taskId], foreignColumns: [tasks.featureId, tasks.id] }).onDelete('restrict'),
  foreignKey({ name: 'attempts_input_fk', columns: [table.projectId, table.inputRef], foreignColumns: [artifacts.projectId, artifacts.id] }).onDelete('restrict'),
  foreignKey({ name: 'attempts_code_fk', columns: [table.projectId, table.codeRef], foreignColumns: [artifacts.projectId, artifacts.id] }).onDelete('restrict'),
  foreignKey({ name: 'attempts_diagnostic_fk', columns: [table.projectId, table.diagnosticRef], foreignColumns: [artifacts.projectId, artifacts.id] }).onDelete('restrict'),
  uniqueIndex('attempts_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('attempts_task_number_unique').on(table.taskId, table.number),
  uniqueIndex('attempts_active_task_unique').on(table.taskId).where(sql`${table.status} IN ('preparing', 'executing', 'verifying')`),
  uniqueIndex('attempts_session_unique').on(table.sessionId).where(sql`${table.sessionId} IS NOT NULL`),
  uniqueIndex('attempts_invocation_unique').on(table.invocationId).where(sql`${table.invocationId} IS NOT NULL`),
  index('attempts_run_id_index').on(table.runId),
]);

export const workspaceLeases = sqliteTable('workspace_leases', {
  id: text('id').primaryKey(), createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1), updatedAt: integer('updated_at').notNull(),
  resourceKey: text('resource_key').notNull(), resourceKind: text('resource_kind').notNull(),
  ownerKind: text('owner_kind').notNull(), ownerId: text('owner_id').notNull(), hostInstanceId: text('host_instance_id').notNull(),
  executionVersion: integer('execution_version').notNull(), state: text('state').notNull().default('held'),
  leaseUntil: integer('lease_until').notNull(), processIdentity: text('process_identity'),
}, table => [
  check('workspace_leases_revision_check', sql`${table.revision} >= 1`),
  check('workspace_leases_resource_check', sql`length(${table.resourceKey}) > 0 AND ${table.resourceKind} IN ('global', 'project', 'workspace')`),
  check('workspace_leases_owner_check', sql`${table.ownerKind} = 'attempt' AND length(${table.hostInstanceId}) > 0`),
  check('workspace_leases_version_check', sql`typeof(${table.executionVersion}) = 'integer' AND ${table.executionVersion} >= 1`),
  check('workspace_leases_state_check', sql`${table.state} IN ('held', 'quarantined')`),
  check('workspace_leases_lease_check', sql`typeof(${table.leaseUntil}) = 'integer' AND ${table.leaseUntil} >= 0`),
  check('workspace_leases_process_check', sql`${table.processIdentity} IS NULL OR (json_valid(${table.processIdentity}) AND json_type(${table.processIdentity}) = 'object')`),
  foreignKey({ name: 'workspace_leases_attempt_fk', columns: [table.projectId, table.ownerId], foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  index('workspace_leases_resource_key_index').on(table.resourceKey),
  index('workspace_leases_owner_id_index').on(table.ownerId),
]);

export const taskClaimReceipts = sqliteTable('task_claim_receipts', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), attemptId: text('attempt_id').notNull(),
  requestDigest: text('request_digest').notNull(), receipt: text('receipt').notNull(),
}, table => [
  check('task_claim_receipts_id_check', sql`length(${table.id}) > 0`),
  check('task_claim_receipts_digest_check', sql`length(${table.requestDigest}) = 64 AND ${table.requestDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('task_claim_receipts_json_check', sql`CASE WHEN json_valid(${table.receipt}) THEN
    json_type(${table.receipt}) = 'object' AND json_extract(${table.receipt}, '$.schemaVersion') IS 1
    AND json_extract(${table.receipt}, '$.claimKey') IS ${table.id}
    AND json_extract(${table.receipt}, '$.attempt.id') IS ${table.attemptId}
    AND json_extract(${table.receipt}, '$.attempt.projectId') IS ${table.projectId} ELSE 0 END`),
  foreignKey({ name: 'task_claim_receipts_attempt_fk', columns: [table.projectId, table.attemptId],
    foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  uniqueIndex('task_claim_receipts_attempt_unique').on(table.attemptId),
]);

export const attemptNotifications = sqliteTable('attempt_notifications', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), attemptId: text('attempt_id').notNull(),
  notificationId: text('notification_id').notNull(), requestDigest: text('request_digest').notNull(), receipt: text('receipt').notNull(),
}, table => [
  check('attempt_notifications_digest_check', sql`length(${table.requestDigest}) = 64 AND ${table.requestDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('attempt_notifications_receipt_check', sql`length(${table.receipt}) <= 8192 AND json_valid(${table.receipt}) AND json_type(${table.receipt}) = 'object'`),
  foreignKey({ name: 'attempt_notifications_attempt_fk', columns: [table.projectId, table.attemptId],
    foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  uniqueIndex('attempt_notifications_identity_unique').on(table.attemptId, table.notificationId),
]);

export const attemptNotificationDiagnostics = sqliteTable('attempt_notification_diagnostics', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull(), attemptId: text('attempt_id').notNull(),
  notificationDigest: text('notification_digest').notNull(), reason: text('reason').notNull(), occurredAt: integer('occurred_at').notNull(),
}, table => [
  check('attempt_diagnostics_digest_check', sql`length(${table.notificationDigest}) = 64 AND ${table.notificationDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('attempt_diagnostics_reason_check', sql`${table.reason} IN ('stale_execution_identity', 'invalid_transition', 'notification_id_reused')`),
  check('attempt_diagnostics_time_check', sql`${table.occurredAt} >= 0`),
  foreignKey({ name: 'attempt_diagnostics_attempt_fk', columns: [table.projectId, table.attemptId],
    foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  uniqueIndex('attempt_diagnostics_identity_unique').on(table.attemptId, table.notificationDigest),
]);

export const managedWorkspaces = sqliteTable('managed_workspaces', {
  id: text('id').primaryKey(), createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1), updatedAt: integer('updated_at').notNull(),
  featureId: text('feature_id').notNull(), repositoryBindingId: text('repository_binding_id').notNull(),
  repositoryBindingRevision: integer('repository_binding_revision').notNull(), repoIdentity: text('repo_identity').notNull(),
  canonicalPath: text('canonical_path').notNull(), gitCommonDir: text('git_common_dir').notNull(), branch: text('branch').notNull(),
  baseCommit: text('base_commit').notNull(), headCommit: text('head_commit'), codeDigest: text('code_digest'),
  status: text('status').notNull(), preparationOperationId: text('preparation_operation_id').notNull(),
  ownerId: text('owner_id').notNull(), hostInstanceId: text('host_instance_id').notNull(), executionVersion: integer('execution_version').notNull(),
  runId: text('run_id').notNull(), attemptId: text('attempt_id').notNull(),
}, (table) => [
  check('managed_workspaces_revision_check', sql`${table.revision} >= 1`),
  check('managed_workspaces_status_check', sql`${table.status} IN ('preparing','ready','retained','quarantined','cleanup_pending','cleaned')`),
  check('managed_workspaces_code_digest_check', sql`${table.codeDigest} IS NULL OR (length(${table.codeDigest}) = 64 AND ${table.codeDigest} NOT GLOB '*[^0-9a-f]*')`),
  check('managed_workspaces_base_commit_check', sql`length(${table.baseCommit}) IN (40,64) AND ${table.baseCommit} NOT GLOB '*[^0-9a-f]*'`),
  check('managed_workspaces_revision_binding_check', sql`${table.repositoryBindingRevision} >= 1`),
  check('managed_workspaces_execution_version_check', sql`${table.executionVersion} >= 1`),
  foreignKey({ name: 'managed_workspaces_feature_same_project_fk', columns: [table.projectId, table.featureId], foreignColumns: [features.projectId, features.id] }).onDelete('restrict'),
  foreignKey({ name: 'managed_workspaces_binding_same_project_fk', columns: [table.projectId, table.repositoryBindingId], foreignColumns: [repositoryBindings.projectId, repositoryBindings.id] }).onDelete('restrict'),
  foreignKey({ name: 'managed_workspaces_run_same_project_fk', columns: [table.projectId, table.runId], foreignColumns: [runs.projectId, runs.id] }).onDelete('restrict'),
  foreignKey({ name: 'managed_workspaces_attempt_same_project_fk', columns: [table.projectId, table.attemptId], foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  uniqueIndex('managed_workspaces_project_feature_unique').on(table.projectId, table.featureId),
  uniqueIndex('managed_workspaces_canonical_path_unique').on(table.canonicalPath),
  uniqueIndex('managed_workspaces_project_id_id_unique').on(table.projectId, table.id),
  index('managed_workspaces_project_updated_index').on(table.projectId, table.updatedAt, table.id),
]);

export const workspaces = managedWorkspaces;

export const workspaceOperations = sqliteTable('workspace_operations', {
  id: text('id').primaryKey(), createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1), updatedAt: integer('updated_at').notNull(),
  featureId: text('feature_id').notNull(), workspaceId: text('workspace_id').notNull(), runId: text('run_id').notNull(), attemptId: text('attempt_id').notNull(),
  ownerId: text('owner_id').notNull(), hostInstanceId: text('host_instance_id').notNull(), executionVersion: integer('execution_version').notNull(),
  kind: text('kind').notNull(), executionStage: text('execution_stage').notNull(), principalId: text('principal_id').notNull(), commandId: text('command_id').notNull(), requestDigest: text('request_digest').notNull(),
  inputSnapshot: text('input_snapshot').notNull(), status: text('status').notNull(), resultJson: text('result_json'), receiptId: text('receipt_id').notNull(), finishSnapshot: text('finish_snapshot'),
}, (table) => [
  check('workspace_operations_revision_check', sql`${table.revision} >= 1`),
  check('workspace_operations_kind_check', sql`${table.kind} IN ('prepare','retain','cleanup','discard')`),
  check('workspace_operations_stage_check', sql`${table.executionStage} IN ('preflight','runtime','verification','commit','cleanup')`),
  check('workspace_operations_status_check', sql`${table.status} IN ('pending','succeeded','failed','blocked')`),
  check('workspace_operations_digest_check', sql`length(${table.requestDigest}) = 64 AND ${table.requestDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('workspace_operations_input_json_check', sql`json_valid(${table.inputSnapshot}) AND json_type(${table.inputSnapshot}) = 'object'`),
  check('workspace_operations_result_json_check', sql`${table.resultJson} IS NULL OR (json_valid(${table.resultJson}) AND json_type(${table.resultJson}) = 'object')`),
  check('workspace_operations_finish_json_check', sql`${table.finishSnapshot} IS NULL OR (json_valid(${table.finishSnapshot}) AND json_type(${table.finishSnapshot}) = 'object')`),
  check('workspace_operations_execution_version_check', sql`${table.executionVersion} >= 1`),
  foreignKey({ name: 'workspace_operations_workspace_fk', columns: [table.projectId, table.workspaceId], foreignColumns: [managedWorkspaces.projectId, managedWorkspaces.id] }).onDelete('restrict'),
  foreignKey({ name: 'workspace_operations_feature_same_project_fk', columns: [table.projectId, table.featureId], foreignColumns: [features.projectId, features.id] }).onDelete('restrict'),
  foreignKey({ name: 'workspace_operations_run_same_project_fk', columns: [table.projectId, table.runId], foreignColumns: [runs.projectId, runs.id] }).onDelete('restrict'),
  foreignKey({ name: 'workspace_operations_attempt_same_project_fk', columns: [table.projectId, table.attemptId], foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  foreignKey({ name: 'workspace_operations_receipt_fk', columns: [table.receiptId], foreignColumns: [commandReceipts.id] }).onDelete('restrict'),
  uniqueIndex('workspace_operations_principal_command_unique').on(table.principalId, table.commandId),
  uniqueIndex('workspace_operations_project_id_id_unique').on(table.projectId, table.id),
  index('workspace_operations_project_created_index').on(table.projectId, table.createdAt, table.id),
]);

export const featureResourceLeases = sqliteTable('feature_resource_leases', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  resourceKey: text('resource_key').notNull(),
  resourceKind: text('resource_kind').notNull(),
  accessMode: text('access_mode').notNull(),
  leaseMode: text('lease_mode').notNull(),
  ownerId: text('owner_id').notNull(),
  ownerVersion: integer('owner_version').notNull(),
  acquiredAt: integer('acquired_at').notNull(),
  leaseUntil: integer('lease_until').notNull(),
  state: text('state').notNull().default('held'),
  waitingReason: text('waiting_reason'),
  releasedAt: integer('released_at'),
}, (table) => [
  check('feature_resource_leases_revision_check', sql`${table.revision} >= 1`),
  check('feature_resource_leases_resource_check', sql`length(${table.resourceKey}) BETWEEN 1 AND 256`),
  check('feature_resource_leases_kind_check', sql`${table.resourceKind} IN ('planning_exclusive', 'feature_code_shared', 'worktree_write_exclusive', 'git_public_metadata_short', 'migration', 'contract')`),
  check('feature_resource_leases_mode_check', sql`${table.accessMode} IN ('exclusive', 'shared') AND ${table.leaseMode} IN ('lease', 'short')`),
  check('feature_resource_leases_semantics_check', sql`
    (${table.resourceKind} = 'feature_code_shared' AND ${table.accessMode} = 'shared' AND ${table.leaseMode} = 'lease')
    OR (${table.resourceKind} <> 'feature_code_shared' AND ${table.accessMode} = 'exclusive'
      AND ((${table.resourceKind} = 'git_public_metadata_short' AND ${table.leaseMode} = 'short')
        OR (${table.resourceKind} <> 'git_public_metadata_short' AND ${table.leaseMode} = 'lease')))`),
  check('feature_resource_leases_owner_check', sql`length(${table.ownerId}) BETWEEN 1 AND 128 AND typeof(${table.ownerVersion}) = 'integer' AND ${table.ownerVersion} >= 1`),
  check('feature_resource_leases_times_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 0
    AND typeof(${table.acquiredAt}) = 'integer' AND ${table.acquiredAt} >= 0
    AND typeof(${table.leaseUntil}) = 'integer' AND ${table.leaseUntil} >= ${table.acquiredAt}`),
  check('feature_resource_leases_state_check', sql`${table.state} IN ('held', 'quarantined', 'released')`),
  check('feature_resource_leases_waiting_reason_check', sql`${table.waitingReason} IS NULL OR (json_valid(${table.waitingReason}) AND json_type(${table.waitingReason}) = 'object'
    AND json_type(${table.waitingReason}, '$.code') = 'text' AND json_type(${table.waitingReason}, '$.resourceKey') = 'text'
    AND json_extract(${table.waitingReason}, '$.resourceKey') = ${table.resourceKey})`),
  check('feature_resource_leases_settlement_check', sql`
    (${table.state} = 'held' AND ${table.waitingReason} IS NULL AND ${table.releasedAt} IS NULL)
    OR (${table.state} = 'quarantined' AND ${table.waitingReason} IS NOT NULL AND ${table.releasedAt} IS NULL)
    OR (${table.state} = 'released' AND ${table.waitingReason} IS NULL AND ${table.releasedAt} IS NOT NULL AND ${table.releasedAt} >= ${table.acquiredAt})`),
  uniqueIndex('feature_resource_leases_active_exclusive_unique')
    .on(table.projectId, table.resourceKey)
    .where(sql`${table.state} IN ('held', 'quarantined') AND ${table.accessMode} = 'exclusive'`),
  uniqueIndex('feature_resource_leases_active_shared_owner_unique')
    .on(table.projectId, table.resourceKey, table.ownerId, table.ownerVersion)
    .where(sql`${table.state} IN ('held', 'quarantined') AND ${table.accessMode} = 'shared'`),
  index('feature_resource_leases_project_state_index').on(table.projectId, table.state, table.updatedAt),
  index('feature_resource_leases_owner_index').on(table.projectId, table.ownerId, table.ownerVersion),
]);

export const schemaMigrations = sqliteTable('schema_migrations', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  /** 唯一递增的迁移版本（≥1）；执行与拒写策略由 F-005 实现。 */
  version: integer('version').notNull(),
  /** 迁移脚本内容的 SHA-256 校验摘要（64 位小写 hex）。 */
  checksum: text('checksum').notNull(),
  appliedAt: integer('applied_at').notNull(),
}, (table) => [
  check('schema_migrations_version_positive_check', sql`${table.version} >= 1`),
  check(
    'schema_migrations_checksum_sha256_check',
    sql`length(${table.checksum}) = 64 AND ${table.checksum} NOT GLOB '*[^0-9a-f]*'`,
  ),
  uniqueIndex('schema_migrations_version_unique').on(table.version),
]);

export const projectProfiles = sqliteTable('project_profiles', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  version: integer('version').notNull(),
  profileRevision: text('profile_revision'),
  status: text('status').notNull(),
  modules: text('modules').notNull(),
  documentRefs: text('document_refs').notNull(),
  detectionRefs: text('detection_refs').notNull(),
  detectionEvidence: text('detection_evidence').notNull().default('[]'),
  confirmedBy: text('confirmed_by'),
  profileDigest: text('profile_digest').notNull(),
}, table => [
  check('project_profiles_revision_check', sql`typeof(${table.revision}) = 'integer' AND ${table.revision} >= 1`),
  check('project_profiles_schema_version_check', sql`typeof(${table.schemaVersion}) = 'integer' AND ${table.schemaVersion} >= 1`),
  check('project_profiles_version_check', sql`typeof(${table.version}) = 'integer' AND ${table.version} >= 1`),
  check('project_profiles_profile_revision_check', sql`${table.profileRevision} IS NULL OR length(${table.profileRevision}) > 0`),
  check('project_profiles_status_check', sql`${table.status} IN ('candidate', 'confirmed', 'rejected', 'manual_configuration_required')`),
  check('project_profiles_modules_json_check', sql`json_valid(${table.modules}) AND json_type(${table.modules}) = 'array'`),
  check('project_profiles_document_refs_json_check', sql`json_valid(${table.documentRefs}) AND json_type(${table.documentRefs}) = 'array'`),
  check('project_profiles_detection_refs_json_check', sql`json_valid(${table.detectionRefs}) AND json_type(${table.detectionRefs}) = 'array'`),
  check('project_profiles_detection_evidence_json_check', sql`json_valid(${table.detectionEvidence}) AND json_type(${table.detectionEvidence}) = 'array'`),
  check('project_profiles_confirmed_by_check', sql`(${table.status} = 'confirmed' AND ${table.confirmedBy} IS NOT NULL) OR (${table.status} <> 'confirmed' AND ${table.confirmedBy} IS NULL)`),
  check('project_profiles_digest_check', sql`length(${table.profileDigest}) = 64 AND ${table.profileDigest} NOT GLOB '*[^0-9a-f]*'`),
  uniqueIndex('project_profiles_project_version_unique').on(table.projectId, table.version),
  uniqueIndex('project_profiles_project_id_unique').on(table.projectId, table.id),
  index('project_profiles_project_status_index').on(table.projectId, table.status, table.version),
]);

export const capabilityModules = sqliteTable('capability_modules', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  moduleKey: text('module_key').notNull(),
  version: text('version').notNull(),
  scope: text('scope').notNull(),
  appliesTo: text('applies_to').notNull(),
  dependencies: text('dependencies').notNull(),
  contentRef: text('content_ref').notNull(),
  digest: text('digest').notNull(),
  status: text('status').notNull(),
}, table => [
  check('capability_modules_revision_check', sql`typeof(${table.revision}) = 'integer' AND ${table.revision} >= 1`),
  check('capability_modules_schema_version_check', sql`typeof(${table.schemaVersion}) = 'integer' AND ${table.schemaVersion} >= 1`),
  check('capability_modules_key_check', sql`length(${table.moduleKey}) > 0`),
  check('capability_modules_version_check', sql`length(${table.version}) > 0`),
  check('capability_modules_scope_json_check', sql`json_valid(${table.scope}) AND json_type(${table.scope}) = 'array'`),
  check('capability_modules_applies_to_json_check', sql`json_valid(${table.appliesTo}) AND json_type(${table.appliesTo}) = 'array'`),
  check('capability_modules_dependencies_json_check', sql`json_valid(${table.dependencies}) AND json_type(${table.dependencies}) = 'array'`),
  check('capability_modules_content_ref_check', sql`length(${table.contentRef}) > 0`),
  check('capability_modules_digest_check', sql`length(${table.digest}) = 64 AND ${table.digest} NOT GLOB '*[^0-9a-f]*'`),
  check('capability_modules_status_check', sql`${table.status} IN ('candidate', 'confirmed', 'rejected', 'manual_configuration_required')`),
  uniqueIndex('capability_modules_project_module_version_unique').on(table.projectId, table.moduleKey, table.version),
  uniqueIndex('capability_modules_project_id_unique').on(table.projectId, table.id),
  index('capability_modules_project_status_index').on(table.projectId, table.status, table.moduleKey, table.version),
]);

/** P06-1 / F-002：画像和能力模块版本均为插后不可变快照。 */

export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  title: text('title').notNull(),
  documentType: text('document_type').notNull(),
  effectiveVersionId: text('effective_version_id'),
  status: text('status').notNull().default('active'),
}, table => [
  check('documents_revision_check', sql`typeof(${table.revision}) = 'integer' AND ${table.revision} >= 1`),
  check('documents_title_check', sql`length(${table.title}) > 0`),
  check('documents_type_check', sql`length(${table.documentType}) > 0`),
  check('documents_status_check', sql`${table.status} IN ('active', 'archived')`),
  uniqueIndex('documents_project_id_unique').on(table.projectId, table.id),
  index('documents_project_status_index').on(table.projectId, table.status, table.id),
]);

export const documentVersions = sqliteTable('document_versions', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  documentId: text('document_id').notNull(),
  version: integer('version').notNull(),
  status: text('status').notNull().default('draft'),
  contentRef: text('content_ref').notNull(),
  contentHash: text('content_hash').notNull(),
  sourceRefs: text('source_refs').notNull().default('[]'),
  reviewStatus: text('review_status').notNull().default('pending'),
  reviewedAgainstRevision: text('reviewed_against_revision'),
}, table => [
  check('document_versions_revision_check', sql`typeof(${table.revision}) = 'integer' AND ${table.revision} >= 1`),
  check('document_versions_version_check', sql`typeof(${table.version}) = 'integer' AND ${table.version} >= 1`),
  check('document_versions_status_check', sql`${table.status} IN ('draft', 'published', 'withdrawn')`),
  check('document_versions_content_ref_check', sql`length(${table.contentRef}) > 0`),
  check('document_versions_content_hash_check', sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`),
  check('document_versions_source_refs_json_check', sql`json_valid(${table.sourceRefs}) AND json_type(${table.sourceRefs}) = 'array'`),
  check('document_versions_review_status_check', sql`${table.reviewStatus} IN ('pending', 'approved', 'rejected')`),
  check('document_versions_reviewed_revision_check', sql`${table.reviewedAgainstRevision} IS NULL OR length(${table.reviewedAgainstRevision}) > 0`),
  foreignKey({
    name: 'document_versions_document_same_project_fk',
    columns: [table.projectId, table.documentId],
    foreignColumns: [documents.projectId, documents.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'document_versions_content_artifact_same_project_fk',
    columns: [table.projectId, table.contentRef],
    foreignColumns: [artifacts.projectId, artifacts.id],
  }).onDelete('restrict'),
  uniqueIndex('document_versions_project_id_unique').on(table.projectId, table.id),
  uniqueIndex('document_versions_document_version_unique').on(table.documentId, table.version),
  index('document_versions_project_status_index').on(table.projectId, table.status, table.version),
]);

export const memoryRecords = sqliteTable('memory_records', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  recordKey: text('record_key').notNull(),
  version: integer('version').notNull(),
  scope: text('scope').notNull(),
  status: text('status').notNull().default('candidate'),
  contentRef: text('content_ref').notNull(),
  contentHash: text('content_hash').notNull(),
  sourceRefs: text('source_refs').notNull().default('[]'),
  retrievalCount: integer('retrieval_count').notNull().default(0),
}, table => [
  check('memory_records_revision_check', sql`typeof(${table.revision}) = 'integer' AND ${table.revision} >= 1`),
  check('memory_records_key_check', sql`length(${table.recordKey}) > 0`),
  check('memory_records_version_check', sql`typeof(${table.version}) = 'integer' AND ${table.version} >= 1`),
  check('memory_records_scope_check', sql`length(${table.scope}) > 0`),
  check('memory_records_status_check', sql`${table.status} IN ('candidate', 'accepted', 'revoked')`),
  check('memory_records_content_ref_check', sql`length(${table.contentRef}) > 0`),
  check('memory_records_content_hash_check', sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`),
  check('memory_records_source_refs_json_check', sql`json_valid(${table.sourceRefs}) AND json_type(${table.sourceRefs}) = 'array'`),
  check('memory_records_retrieval_count_check', sql`typeof(${table.retrievalCount}) = 'integer' AND ${table.retrievalCount} >= 0`),
  foreignKey({
    name: 'memory_records_content_artifact_same_project_fk',
    columns: [table.projectId, table.contentRef],
    foreignColumns: [artifacts.projectId, artifacts.id],
  }).onDelete('restrict'),
  uniqueIndex('memory_records_project_key_version_unique').on(table.projectId, table.recordKey, table.version),
  uniqueIndex('memory_records_project_id_unique').on(table.projectId, table.id),
  index('memory_records_project_status_index').on(table.projectId, table.status, table.recordKey, table.version),
]);

/** P06-2：正文引用、版本身份和来源在写入后不可被原地换绑。 */

/**
 * P03-6 / F-006：最小 Work Session 与 Attempt 执行诊断持久关联（sessions，迁移 v20）。
 * 顶层 Work Session 唯一关联同项目 Attempt（attempt_id 部分唯一）；生命周期区分
 * 启动预占（reserved）/实际已启动（started）/执行已结束（ended）/已停止（stopped）；
 * 正文一律经 ready Artifact 引用；未知指标保持 NULL。不建 ChatTurn/session_messages/
 * SessionRecorder 表组；不引入配置/计划版本表。
 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1), updatedAt: integer('updated_at').notNull(),
  attemptId: text('attempt_id'), parentSessionId: text('parent_session_id'),
  kind: text('kind').notNull(), title: text('title'),
  purpose: text('purpose').notNull(), runtime: text('runtime').notNull(), adapterVersion: text('adapter_version').notNull(),
  providerSessionId: text('provider_session_id'),
  status: text('status').notNull().default('reserved'),
  executionStage: text('execution_stage').notNull().default('preflight'),
  inputRef: text('input_ref').notNull(), resultRef: text('result_ref'),
  lastActivityAt: integer('last_activity_at').notNull(),
  startedAt: integer('started_at'), endedAt: integer('ended_at'), stoppedAt: integer('stopped_at'),
  nativeRef: text('native_ref'), recordingWatermark: integer('recording_watermark'), recordingGaps: text('recording_gaps'),
}, table => [
  check('sessions_revision_check', sql`${table.revision} >= 1`),
  check('sessions_kind_check', sql`${table.kind} IN ('work', 'chat')`),
  check('sessions_status_check', sql`${table.status} IN ('reserved', 'started', 'ended', 'stopped')`),
  check('sessions_stage_check', sql`${table.executionStage} IN ('preflight', 'runtime', 'verification', 'commit', 'cleanup')`),
  check('sessions_descriptor_check', sql`length(${table.purpose}) > 0 AND length(${table.runtime}) > 0
    AND length(${table.adapterVersion}) > 0
    AND (${table.providerSessionId} IS NULL OR length(${table.providerSessionId}) > 0)
    AND (${table.title} IS NULL OR (length(${table.title}) BETWEEN 1 AND 200))`),
  check('sessions_times_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 0
    AND typeof(${table.lastActivityAt}) = 'integer' AND ${table.lastActivityAt} >= 0
    AND (${table.startedAt} IS NULL OR (typeof(${table.startedAt}) = 'integer' AND ${table.startedAt} >= 0))
    AND (${table.endedAt} IS NULL OR (typeof(${table.endedAt}) = 'integer' AND ${table.endedAt} >= 0))
    AND (${table.stoppedAt} IS NULL OR (typeof(${table.stoppedAt}) = 'integer' AND ${table.stoppedAt} >= 0))`),
  check('sessions_native_ref_check', sql`${table.nativeRef} IS NULL OR (json_valid(${table.nativeRef})
    AND json_type(${table.nativeRef}) = 'object'
    AND json_type(${table.nativeRef}, '$.schemaVersion') IS 'integer'
    AND json_extract(${table.nativeRef}, '$.schemaVersion') = 1
    AND json_type(${table.nativeRef}, '$.storageKind') = 'text'
    AND length(json_extract(${table.nativeRef}, '$.storageKind')) > 0
    AND json_type(${table.nativeRef}, '$.formatVersion') = 'text'
    AND length(json_extract(${table.nativeRef}, '$.formatVersion')) > 0)`),
  check('sessions_watermark_check', sql`${table.recordingWatermark} IS NULL
    OR (typeof(${table.recordingWatermark}) = 'integer' AND ${table.recordingWatermark} >= 0)`),
  check('sessions_gaps_check', sql`${table.recordingGaps} IS NULL OR (json_valid(${table.recordingGaps})
    AND json_type(${table.recordingGaps}) = 'array' AND length(${table.recordingGaps}) <= 8192)`),
  check('sessions_lifecycle_shape_check', sql`
    (${table.kind} = 'chat' AND ${table.attemptId} IS NULL)
    OR (${table.kind} = 'work' AND ${table.attemptId} IS NOT NULL)
    OR (${table.kind} = 'work' AND ${table.parentSessionId} IS NOT NULL AND ${table.attemptId} IS NULL)`),
  check('sessions_status_shape_check', sql`
    (${table.status} = 'reserved' AND ${table.startedAt} IS NULL AND ${table.endedAt} IS NULL AND ${table.stoppedAt} IS NULL AND ${table.resultRef} IS NULL)
    OR (${table.status} = 'started' AND ${table.startedAt} IS NOT NULL AND ${table.endedAt} IS NULL AND ${table.stoppedAt} IS NULL AND ${table.resultRef} IS NULL)
    OR (${table.status} = 'ended' AND ${table.endedAt} IS NOT NULL AND ${table.stoppedAt} IS NULL
        AND (${table.startedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}))
    OR (${table.status} = 'stopped' AND ${table.endedAt} IS NOT NULL AND ${table.stoppedAt} IS NOT NULL
        AND ${table.stoppedAt} >= ${table.endedAt} AND (${table.startedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}))`),
  foreignKey({ name: 'sessions_attempt_fk', columns: [table.projectId, table.attemptId], foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  foreignKey({ name: 'sessions_parent_fk', columns: [table.projectId, table.parentSessionId], foreignColumns: [table.projectId, table.id] }).onDelete('restrict'),
  foreignKey({ name: 'sessions_input_ref_fk', columns: [table.projectId, table.inputRef], foreignColumns: [artifacts.projectId, artifacts.id] }).onDelete('restrict'),
  foreignKey({ name: 'sessions_result_ref_fk', columns: [table.projectId, table.resultRef], foreignColumns: [artifacts.projectId, artifacts.id] }).onDelete('restrict'),
  uniqueIndex('sessions_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('sessions_attempt_unique').on(table.attemptId).where(sql`${table.attemptId} IS NOT NULL`),
  index('sessions_project_kind_activity_index').on(table.projectId, table.kind, table.lastActivityAt),
]);

/**
 * P04-5 / F-001：Work 公开消息、工具操作和附件正文的有界索引。
 * 正文只保存为同项目 ready Artifact；这些表只保留身份、顺序、来源和摘要引用，
 * 不复制消息正文、工具参数/结果或 SDK 私有档案。
 */
export const sessionMessages = sqliteTable('session_messages', {
  id: text('id').primaryKey(), createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull(), revision: integer('revision').notNull().default(1), updatedAt: integer('updated_at').notNull(),
  sessionId: text('session_id').notNull(), runId: text('run_id').notNull(), attemptId: text('attempt_id').notNull(),
  invocationId: text('invocation_id').notNull(), executionVersion: integer('execution_version').notNull(),
  sequence: integer('sequence').notNull(), eventId: text('event_id').notNull(), messageKey: text('message_key').notNull(),
  kind: text('kind').notNull(), role: text('role').notNull(),
  contentRef: text('content_ref').notNull(), contentHash: text('content_hash').notNull(), contentSizeBytes: integer('content_size_bytes').notNull(),
  contentLocator: text('content_locator').notNull(), providerMessageId: text('provider_message_id'), toolCallId: text('tool_call_id'),
  parentToolCallId: text('parent_tool_call_id'), source: text('source').notNull(), sourceRefs: text('source_refs').notNull(),
  attachmentRefs: text('attachment_refs').notNull(), occurredAt: integer('occurred_at').notNull(), recordedAt: integer('recorded_at').notNull(),
  truncated: integer('truncated').notNull().default(0), redacted: integer('redacted').notNull().default(0),
}, (table) => [
  check('session_messages_numeric_check', sql`(typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.revision}) = 'integer' AND ${table.revision} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.executionVersion}) = 'integer' AND ${table.executionVersion} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.sequence}) = 'integer' AND ${table.sequence} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.contentSizeBytes}) = 'integer' AND ${table.contentSizeBytes} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.occurredAt}) = 'integer' AND ${table.occurredAt} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.recordedAt}) = 'integer' AND ${table.recordedAt} BETWEEN 0 AND 9007199254740991)`),
  check('session_messages_revision_check', sql`${table.revision} >= 1`),
  check('session_messages_bounds_check', sql`length(${table.eventId}) <= 256 AND length(${table.messageKey}) <= 256
    AND length(${table.contentLocator}) BETWEEN 1 AND 1024
    AND (${table.providerMessageId} IS NULL OR length(${table.providerMessageId}) BETWEEN 1 AND 256)
    AND (${table.toolCallId} IS NULL OR length(${table.toolCallId}) BETWEEN 1 AND 256)
    AND (${table.parentToolCallId} IS NULL OR length(${table.parentToolCallId}) BETWEEN 1 AND 256)
    AND length(CAST(${table.sourceRefs} AS BLOB)) <= 65536 AND length(CAST(${table.attachmentRefs} AS BLOB)) <= 65536`),
  check('session_messages_tool_check', sql`(${table.kind} NOT IN ('tool_started','tool_finished') OR ${table.toolCallId} IS NOT NULL)
    AND (${table.parentToolCallId} IS NULL OR (${table.toolCallId} IS NOT NULL AND ${table.parentToolCallId} <> ${table.toolCallId}))`),
  check('session_messages_execution_version_check', sql`${table.executionVersion} >= 1`),
  check('session_messages_sequence_check', sql`${table.sequence} >= 1`),
  check('session_messages_text_check', sql`length(${table.eventId}) > 0 AND length(${table.messageKey}) > 0
    AND length(${table.invocationId}) > 0 AND length(${table.kind}) > 0 AND length(${table.role}) > 0`),
  check('session_messages_kind_check', sql`${table.kind} IN ('message','tool_started','tool_finished','error','final_result','attachment')`),
  check('session_messages_role_check', sql`${table.role} IN ('system','user','assistant','tool','error','result')`),
  check('session_messages_source_check', sql`${table.source} IN ('live','native','recovered','mixed')`),
  check('session_messages_content_size_check', sql`${table.contentSizeBytes} >= 0`),
  check('session_messages_timestamp_check', sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= 0
    AND ${table.occurredAt} >= 0 AND ${table.recordedAt} >= ${table.occurredAt}`),
  check('session_messages_boolean_check', sql`${table.truncated} IN (0,1) AND ${table.redacted} IN (0,1)`),
  check('session_messages_source_refs_check', sql`json_valid(${table.sourceRefs}) AND json_type(${table.sourceRefs}) = 'array'
    AND json_array_length(${table.sourceRefs}) <= 16`),
  check('session_messages_attachment_refs_check', sql`json_valid(${table.attachmentRefs}) AND json_type(${table.attachmentRefs}) = 'array'
    AND json_array_length(${table.attachmentRefs}) <= 32`),
  foreignKey({ name: 'session_messages_project_fk', columns: [table.projectId], foreignColumns: [projects.id] }).onDelete('restrict'),
  foreignKey({ name: 'session_messages_session_fk', columns: [table.projectId, table.sessionId], foreignColumns: [sessions.projectId, sessions.id] }).onDelete('restrict'),
  foreignKey({ name: 'session_messages_run_fk', columns: [table.projectId, table.runId], foreignColumns: [runs.projectId, runs.id] }).onDelete('restrict'),
  foreignKey({ name: 'session_messages_attempt_fk', columns: [table.projectId, table.attemptId], foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  foreignKey({ name: 'session_messages_content_artifact_fk', columns: [table.projectId, table.contentRef], foreignColumns: [artifacts.projectId, artifacts.id] }).onDelete('restrict'),
  uniqueIndex('session_messages_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('session_messages_session_sequence_unique').on(table.sessionId, table.sequence),
  uniqueIndex('session_messages_session_message_key_unique').on(table.sessionId, table.messageKey),
  uniqueIndex('session_messages_project_event_unique').on(table.projectId, table.eventId),
  index('session_messages_project_session_sequence_index').on(table.projectId, table.sessionId, table.sequence),
]);

/** P04-5 / F-001：Work 记录完整度索引；每个版本不可变，正文仍由 Artifact 承载。 */
export const recordingManifests = sqliteTable('recording_manifests', {
  id: text('id').primaryKey(), createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull(), revision: integer('revision').notNull().default(1), updatedAt: integer('updated_at').notNull(),
  sessionId: text('session_id').notNull(), runId: text('run_id').notNull(), attemptId: text('attempt_id').notNull(),
  invocationId: text('invocation_id').notNull(), executionVersion: integer('execution_version').notNull(), version: integer('version').notNull(),
  manifestRef: text('manifest_ref'), manifestHash: text('manifest_hash'), manifestSizeBytes: integer('manifest_size_bytes'),
  manifestLocator: text('manifest_locator'), watermark: integer('watermark'), finalSequence: integer('final_sequence'),
  sequenceReconciliation: text('sequence_reconciliation').notNull(), coverage: text('coverage').notNull(), source: text('source').notNull(),
  scope: text('scope').notNull(), missingReasons: text('missing_reasons').notNull(), diagnostics: text('diagnostics').notNull(),
  truncation: text('truncation').notNull(), redaction: text('redaction').notNull(), sdkVersion: text('sdk_version'), formatVersion: text('format_version').notNull(),
  nativeRef: text('native_ref'), unknownEventCount: integer('unknown_event_count'), finalized: integer('finalized').notNull().default(0),
}, (table) => [
  check('recording_manifests_numeric_check', sql`(typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.revision}) = 'integer' AND ${table.revision} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.executionVersion}) = 'integer' AND ${table.executionVersion} BETWEEN 0 AND 9007199254740991)
    AND (typeof(${table.version}) = 'integer' AND ${table.version} BETWEEN 0 AND 9007199254740991)
    AND (${table.watermark} IS NULL OR (typeof(${table.watermark}) = 'integer' AND ${table.watermark} BETWEEN 0 AND 9007199254740991))
    AND (${table.finalSequence} IS NULL OR (typeof(${table.finalSequence}) = 'integer' AND ${table.finalSequence} BETWEEN 0 AND 9007199254740991))
    AND (${table.unknownEventCount} IS NULL OR (typeof(${table.unknownEventCount}) = 'integer' AND ${table.unknownEventCount} BETWEEN 0 AND 9007199254740991))
    AND (${table.manifestSizeBytes} IS NULL OR (typeof(${table.manifestSizeBytes}) = 'integer' AND ${table.manifestSizeBytes} BETWEEN 0 AND 9007199254740991))`),
  check('recording_manifests_revision_check', sql`${table.revision} >= 1`),
  check('recording_manifests_ref_shape_check', sql`(${table.manifestRef} IS NULL AND ${table.manifestHash} IS NULL AND ${table.manifestSizeBytes} IS NULL AND ${table.manifestLocator} IS NULL)
    OR (${table.manifestRef} IS NOT NULL AND ${table.manifestHash} IS NOT NULL AND ${table.manifestSizeBytes} IS NOT NULL AND ${table.manifestLocator} IS NOT NULL)`),
  check('recording_manifests_bounds_check', sql`length(${table.formatVersion}) BETWEEN 1 AND 128
    AND (${table.sdkVersion} IS NULL OR length(${table.sdkVersion}) BETWEEN 1 AND 128)
    AND length(CAST(${table.scope} AS BLOB)) <= 65536 AND length(CAST(${table.missingReasons} AS BLOB)) <= 65536
    AND length(CAST(${table.diagnostics} AS BLOB)) <= 65536 AND length(CAST(${table.truncation} AS BLOB)) <= 65536
    AND length(CAST(${table.redaction} AS BLOB)) <= 65536
    AND (${table.nativeRef} IS NULL OR length(CAST(${table.nativeRef} AS BLOB)) <= 2048)`),
  check('recording_manifests_honest_check', sql`(${table.coverage} = 'complete' OR json_array_length(${table.missingReasons}) > 0)
    AND (${table.coverage} <> 'complete' OR (${table.unknownEventCount} IS 0 AND json_extract(${table.truncation}, '$.applied') IS 0
      AND (${table.finalized} = 0 OR ${table.sequenceReconciliation} = 'match')))
    AND (${table.sequenceReconciliation} <> 'match' OR (${table.watermark} IS NOT NULL AND ${table.finalSequence} IS NOT NULL AND ${table.watermark} = ${table.finalSequence}))`),
  check('recording_manifests_version_check', sql`${table.version} >= 1 AND ${table.executionVersion} >= 1`),
  check('recording_manifests_watermark_check', sql`${table.watermark} IS NULL OR ${table.watermark} >= 0`),
  check('recording_manifests_final_sequence_check', sql`${table.finalSequence} IS NULL OR ${table.finalSequence} >= 0`),
  check('recording_manifests_watermark_order_check', sql`${table.watermark} IS NULL OR ${table.finalSequence} IS NULL OR ${table.watermark} <= ${table.finalSequence}`),
  check('recording_manifests_reconciliation_check', sql`${table.sequenceReconciliation} IN ('match','mismatch','not_available')`),
  check('recording_manifests_coverage_check', sql`${table.coverage} IN ('complete','partial','failed')`),
  check('recording_manifests_source_check', sql`${table.source} IN ('live','native','recovered','mixed')`),
  check('recording_manifests_json_check', sql`json_valid(${table.scope}) AND json_type(${table.scope}) = 'object'
    AND json_valid(${table.missingReasons}) AND json_type(${table.missingReasons}) = 'array' AND json_array_length(${table.missingReasons}) <= 32
    AND json_valid(${table.diagnostics}) AND json_type(${table.diagnostics}) = 'array' AND json_array_length(${table.diagnostics}) <= 32
    AND json_valid(${table.truncation}) AND json_type(${table.truncation}) = 'object'
    AND json_valid(${table.redaction}) AND json_type(${table.redaction}) = 'object'`),
  check('recording_manifests_complete_shape_check', sql`${table.coverage} <> 'complete' OR json_array_length(${table.missingReasons}) = 0`),
  check('recording_manifests_boolean_check', sql`${table.finalized} IN (0,1)`),
  check('recording_manifests_unknown_count_check', sql`${table.unknownEventCount} IS NULL OR ${table.unknownEventCount} >= 0`),
  check('recording_manifests_time_check', sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= 0`),
  foreignKey({ name: 'recording_manifests_project_fk', columns: [table.projectId], foreignColumns: [projects.id] }).onDelete('restrict'),
  foreignKey({ name: 'recording_manifests_session_fk', columns: [table.projectId, table.sessionId], foreignColumns: [sessions.projectId, sessions.id] }).onDelete('restrict'),
  foreignKey({ name: 'recording_manifests_run_fk', columns: [table.projectId, table.runId], foreignColumns: [runs.projectId, runs.id] }).onDelete('restrict'),
  foreignKey({ name: 'recording_manifests_attempt_fk', columns: [table.projectId, table.attemptId], foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  foreignKey({ name: 'recording_manifests_artifact_fk', columns: [table.projectId, table.manifestRef], foreignColumns: [artifacts.projectId, artifacts.id] }).onDelete('restrict'),
  uniqueIndex('recording_manifests_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('recording_manifests_session_version_unique').on(table.sessionId, table.version),
  index('recording_manifests_project_session_version_index').on(table.projectId, table.sessionId, table.version),
]);

/**
 * P03-7 / F-002：VerificationBatch / CheckResult 与不可变验证证据身份（迁移 v21）。
 * 批次把针对同一代码状态的一组可信检查归为权威边界（代码/策略/环境身份 + 检查定义
 * 快照 + 选择/回退理由）；逐项结果保存状态、argv/cwd/timeout 快照、时间、exit_code/
 * signal、输出 Artifact 引用与有界 tail；未知指标保持 NULL。不建 check_definitions
 * 表与配置/计划版本表；大输出正文仅引用同项目 ready Artifact 并记录摘要身份。
 */
export const verificationBatches = sqliteTable('verification_batches', {
  id: text('id').primaryKey(), createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1), updatedAt: integer('updated_at').notNull(),
  featureId: text('feature_id').notNull(), runId: text('run_id').notNull(), taskId: text('task_id').notNull(),
  attemptId: text('attempt_id').notNull(), executionVersion: integer('execution_version').notNull(),
  operation: text('operation').notNull(), codeDigest: text('code_digest').notNull(), policyDigest: text('policy_digest').notNull(),
  environmentSummary: text('environment_summary').notNull(), checkSnapshot: text('check_snapshot').notNull(),
  selection: text('selection').notNull(), status: text('status').notNull().default('running'),
  startedAt: integer('started_at'), endedAt: integer('ended_at'),
}, (table) => [
  check('verification_batches_revision_check', sql`${table.revision} >= 1`),
  check('verification_batches_version_check', sql`typeof(${table.executionVersion}) = 'integer' AND ${table.executionVersion} >= 1`),
  check('verification_batches_operation_check', sql`length(${table.operation}) > 0 AND length(${table.operation}) <= 128`),
  check('verification_batches_digest_check', sql`length(${table.codeDigest}) = 64 AND ${table.codeDigest} NOT GLOB '*[^0-9a-f]*'
    AND length(${table.policyDigest}) = 64 AND ${table.policyDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('verification_batches_environment_check', sql`json_valid(${table.environmentSummary})
    AND json_type(${table.environmentSummary}) = 'object' AND length(${table.environmentSummary}) <= 8192`),
  check('verification_batches_snapshot_check', sql`json_valid(${table.checkSnapshot})
    AND json_type(${table.checkSnapshot}) = 'array' AND json_array_length(${table.checkSnapshot}) >= 1
    AND length(${table.checkSnapshot}) <= 65536`),
  check('verification_batches_selection_check', sql`json_valid(${table.selection})
    AND json_type(${table.selection}) = 'object' AND length(${table.selection}) <= 16384`),
  check('verification_batches_status_check', sql`${table.status} IN ('running', 'passed', 'failed', 'error', 'inconclusive')`),
  check('verification_batches_times_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 0
    AND (${table.startedAt} IS NULL OR (typeof(${table.startedAt}) = 'integer' AND ${table.startedAt} >= 0))
    AND (${table.endedAt} IS NULL OR (typeof(${table.endedAt}) = 'integer' AND ${table.endedAt} >= 0))
    AND ((${table.status} = 'running' AND ${table.endedAt} IS NULL)
      OR (${table.status} <> 'running' AND ${table.endedAt} IS NOT NULL AND (${table.startedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt})))`),
  foreignKey({ name: 'verification_batches_feature_fk', columns: [table.projectId, table.featureId], foreignColumns: [features.projectId, features.id] }).onDelete('restrict'),
  foreignKey({ name: 'verification_batches_run_fk', columns: [table.projectId, table.runId], foreignColumns: [runs.projectId, runs.id] }).onDelete('restrict'),
  foreignKey({ name: 'verification_batches_task_fk', columns: [table.featureId, table.taskId], foreignColumns: [tasks.featureId, tasks.id] }).onDelete('restrict'),
  foreignKey({ name: 'verification_batches_attempt_fk', columns: [table.projectId, table.attemptId], foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  uniqueIndex('verification_batches_project_id_id_unique').on(table.projectId, table.id),
  index('verification_batches_project_attempt_index').on(table.projectId, table.attemptId, table.id),
]);

export const checkResults = sqliteTable('check_results', {
  id: text('id').primaryKey(), createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1), updatedAt: integer('updated_at').notNull(),
  batchId: text('batch_id').notNull(), checkKey: text('check_key').notNull(),
  argvJson: text('argv_json').notNull(), cwdRef: text('cwd_ref'), environmentRef: text('environment_ref'),
  timeoutMs: integer('timeout_ms').notNull(), required: integer('required').notNull(),
  status: text('status').notNull(), exitCode: integer('exit_code'), signal: text('signal'),
  timedOut: integer('timed_out').notNull().default(0),
  outputArtifactId: text('output_artifact_id'), outputDigest: text('output_digest'), outputTail: text('output_tail'),
  startedAt: integer('started_at'), endedAt: integer('ended_at'),
}, (table) => [
  check('check_results_revision_check', sql`${table.revision} >= 1`),
  check('check_results_check_key_check', sql`length(${table.checkKey}) > 0 AND length(${table.checkKey}) <= 128`),
  check('check_results_status_check', sql`${table.status} IN ('passed', 'failed', 'error', 'inconclusive', 'not_run')`),
  check('check_results_argv_json_check', sql`json_valid(${table.argvJson}) AND json_type(${table.argvJson}) = 'array'
    AND json_array_length(${table.argvJson}) >= 1`),
  check('check_results_timeout_check', sql`typeof(${table.timeoutMs}) = 'integer' AND ${table.timeoutMs} >= 1`),
  check('check_results_required_check', sql`${table.required} IN (0, 1)`),
  check('check_results_timed_out_check', sql`${table.timedOut} IN (0, 1)`),
  check('check_results_exit_check', sql`${table.exitCode} IS NULL OR typeof(${table.exitCode}) = 'integer'`),
  check('check_results_signal_check', sql`${table.signal} IS NULL OR (length(${table.signal}) > 0 AND length(${table.signal}) <= 32)`),
  check('check_results_digest_check', sql`${table.outputDigest} IS NULL
    OR (length(${table.outputDigest}) = 64 AND ${table.outputDigest} NOT GLOB '*[^0-9a-f]*')`),
  check('check_results_tail_check', sql`${table.outputTail} IS NULL OR length(${table.outputTail}) <= 8192`),
  check('check_results_times_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 0
    AND (${table.startedAt} IS NULL OR (typeof(${table.startedAt}) = 'integer' AND ${table.startedAt} >= 0))
    AND (${table.endedAt} IS NULL OR (typeof(${table.endedAt}) = 'integer' AND ${table.endedAt} >= 0))
    AND (${table.startedAt} IS NULL OR ${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt})`),
  check('check_results_output_shape_check', sql`(${table.outputArtifactId} IS NULL) = (${table.outputDigest} IS NULL)`),
  check('check_results_status_shape_check', sql`
    (${table.status} = 'not_run' AND ${table.exitCode} IS NULL AND ${table.signal} IS NULL AND ${table.timedOut} = 0
      AND ${table.startedAt} IS NULL AND ${table.endedAt} IS NULL)
    OR (${table.status} = 'passed' AND ${table.exitCode} = 0 AND ${table.timedOut} = 0)
    OR (${table.status} IN ('failed', 'error', 'inconclusive'))`),
  check('check_results_timed_out_shape_check', sql`${table.timedOut} = 0 OR ${table.status} IN ('failed', 'error')`),
  foreignKey({ name: 'check_results_batch_fk', columns: [table.projectId, table.batchId], foreignColumns: [verificationBatches.projectId, verificationBatches.id] }).onDelete('restrict'),
  foreignKey({ name: 'check_results_output_artifact_fk', columns: [table.projectId, table.outputArtifactId], foreignColumns: [artifacts.projectId, artifacts.id] }).onDelete('restrict'),
  uniqueIndex('check_results_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('check_results_batch_check_unique').on(table.batchId, table.checkKey),
]);

/**
 * P03-8 / F-002：受控 Git 提交意图与操作回执（迁移 v26）。
 *
 * 意图列在注册时固定；终态写回只触达 status、actual commit/tree、exit/duration、
 * reason、receipt、delivery_status、settled_at、revision/updated_at。数据库触发器
 * （迁移 v26）提供不可变与终态防御纵深；应用层在同一事务内先 CAS 再写回。
 */
export const gitOperations = sqliteTable('git_operations', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  revision: integer('revision').notNull().default(1),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  featureId: text('feature_id').notNull(),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id'),
  executionVersion: integer('execution_version').notNull(),
  operationType: text('operation_type').notNull(),
  repositoryBindingId: text('repository_binding_id').notNull(),
  repoIdentity: text('repo_identity').notNull(),
  worktreePath: text('worktree_path').notNull(),
  expectedHead: text('expected_head').notNull(),
  candidateTree: text('candidate_tree').notNull(),
  integrationPlan: text('integration_plan'),
  budgetSnapshot: text('budget_snapshot'),
  codeDigest: text('code_digest').notNull(),
  verificationRefs: text('verification_refs').notNull(),
  approvalRefs: text('approval_refs').notNull(),
  message: text('message').notNull(),
  identityName: text('identity_name').notNull(),
  identityEmail: text('identity_email').notNull(),
  deliveryPolicyDigest: text('delivery_policy_digest').notNull(),
  runtimeSource: text('runtime_source'),
  ownerId: text('owner_id').notNull(),
  hostInstanceId: text('host_instance_id').notNull(),
  intentDigest: text('intent_digest').notNull(),
  status: text('status').notNull().default('pending'),
  actualCommit: text('actual_commit'),
  actualTree: text('actual_tree'),
  exitCode: integer('exit_code'),
  durationMs: integer('duration_ms'),
  reasonCode: text('reason_code'),
  receipt: text('receipt'),
  integrationResult: text('integration_result'),
  recoveryState: text('recovery_state').notNull().default('none'),
  workspacePreserved: integer('workspace_preserved').notNull().default(0),
  deliveryStatus: text('delivery_status'),
  settledAt: integer('settled_at'),
}, (table) => [
  check('git_operations_revision_check', sql`${table.revision} >= 1`),
  check('git_operations_version_check', sql`typeof(${table.executionVersion}) = 'integer' AND ${table.executionVersion} >= 1`),
  check('git_operations_type_check', sql`${table.operationType} IN ('feature_final_commit', 'task_commit', 'integration', 'integration_commit')`),
  check('git_operations_task_attempt_check', sql`${table.operationType} <> 'task_commit' OR ${table.attemptId} IS NOT NULL`),
  check('git_operations_oid_check', sql`
    (length(${table.expectedHead}) IN (40, 64) AND ${table.expectedHead} NOT GLOB '*[^0-9a-f]*')
    AND (length(${table.candidateTree}) IN (40, 64) AND ${table.candidateTree} NOT GLOB '*[^0-9a-f]*')
    AND (${table.actualCommit} IS NULL OR (length(${table.actualCommit}) IN (40, 64) AND ${table.actualCommit} NOT GLOB '*[^0-9a-f]*'))
    AND (${table.actualTree} IS NULL OR (length(${table.actualTree}) IN (40, 64) AND ${table.actualTree} NOT GLOB '*[^0-9a-f]*'))`),
  check('git_operations_digest_check', sql`
    length(${table.codeDigest}) = 64 AND ${table.codeDigest} NOT GLOB '*[^0-9a-f]*'
    AND length(${table.deliveryPolicyDigest}) = 64 AND ${table.deliveryPolicyDigest} NOT GLOB '*[^0-9a-f]*'
    AND length(${table.intentDigest}) = 64 AND ${table.intentDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('git_operations_refs_check', sql`
    json_valid(${table.verificationRefs}) AND json_type(${table.verificationRefs}) = 'array'
    AND json_valid(${table.approvalRefs}) AND json_type(${table.approvalRefs}) = 'array'`),
  check('git_operations_message_check', sql`length(trim(${table.message})) > 0 AND length(${table.message}) <= 16384`),
  check('git_operations_identity_check', sql`length(trim(${table.identityName})) > 0 AND length(trim(${table.identityEmail})) > 0`),
  check('git_operations_runtime_check', sql`${table.runtimeSource} IS NULL OR (json_valid(${table.runtimeSource}) AND json_type(${table.runtimeSource}) = 'object')`),
  check('git_operations_status_check', sql`${table.status} IN ('pending', 'succeeded', 'no_change', 'failed', 'unknown')`),
  check('git_operations_delivery_status_check', sql`${table.deliveryStatus} IS NULL OR ${table.deliveryStatus} IN ('not_requested', 'pending', 'succeeded', 'failed')`),
  check('git_operations_exit_check', sql`${table.exitCode} IS NULL OR (typeof(${table.exitCode}) = 'integer' AND ${table.exitCode} >= 0)`),
  check('git_operations_duration_check', sql`${table.durationMs} IS NULL OR (typeof(${table.durationMs}) = 'integer' AND ${table.durationMs} >= 0)`),
  check('git_operations_reason_check', sql`${table.reasonCode} IS NULL OR ${table.reasonCode} GLOB '[a-z]*' AND length(${table.reasonCode}) <= 64 AND ${table.reasonCode} NOT GLOB '*[^a-z0-9_]*'`),
  check('git_operations_receipt_check', sql`${table.receipt} IS NULL OR (json_valid(${table.receipt}) AND json_type(${table.receipt}) = 'object')`),
  check('git_operations_integration_plan_check', sql`${table.integrationPlan} IS NULL OR (json_valid(${table.integrationPlan}) AND json_type(${table.integrationPlan}) = 'object')`),
  check('git_operations_budget_snapshot_check', sql`${table.budgetSnapshot} IS NULL OR (json_valid(${table.budgetSnapshot}) AND json_type(${table.budgetSnapshot}) = 'object')`),
  check('git_operations_integration_result_check', sql`${table.integrationResult} IS NULL OR (json_valid(${table.integrationResult}) AND json_type(${table.integrationResult}) = 'object')`),
  check('git_operations_recovery_check', sql`${table.recoveryState} IN ('none', 'resumable', 'preserved', 'cleaned', 'quarantined') AND ${table.workspacePreserved} IN (0, 1)`),
  check('git_operations_times_check', sql`
    typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 0
    AND (${table.settledAt} IS NULL OR (typeof(${table.settledAt}) = 'integer' AND ${table.settledAt} >= 0))`),
  check('git_operations_terminal_shape_check', sql`
    (${table.status} = 'pending' AND ${table.actualCommit} IS NULL AND ${table.actualTree} IS NULL AND ${table.exitCode} IS NULL
      AND ${table.durationMs} IS NULL AND ${table.reasonCode} IS NULL AND ${table.receipt} IS NULL
      AND ${table.deliveryStatus} IS NULL AND ${table.settledAt} IS NULL)
    OR (${table.status} = 'succeeded' AND ${table.actualCommit} IS NOT NULL
      AND ((${table.operationType} IN ('integration', 'integration_commit') AND ${table.actualTree} IS NOT NULL AND ${table.integrationResult} IS NOT NULL)
        OR (${table.operationType} NOT IN ('integration', 'integration_commit') AND ${table.actualTree} = ${table.candidateTree}))
      AND ${table.receipt} IS NOT NULL AND ${table.deliveryStatus} = CASE WHEN ${table.operationType} IN ('task_commit', 'integration', 'integration_commit') THEN 'not_requested' ELSE 'succeeded' END AND ${table.settledAt} IS NOT NULL)
    OR (${table.status} = 'no_change' AND ${table.actualCommit} = ${table.expectedHead} AND ${table.actualTree} IS NOT NULL
      AND ${table.receipt} IS NOT NULL AND ${table.deliveryStatus} = CASE WHEN ${table.operationType} IN ('task_commit', 'integration', 'integration_commit') THEN 'not_requested' ELSE 'succeeded' END AND ${table.settledAt} IS NOT NULL)
    OR (${table.status} = 'failed' AND ${table.receipt} IS NOT NULL AND ${table.deliveryStatus} = CASE WHEN ${table.operationType} IN ('task_commit', 'integration', 'integration_commit') THEN 'not_requested' ELSE 'failed' END AND ${table.settledAt} IS NOT NULL)
    OR (${table.status} = 'unknown' AND ${table.actualCommit} IS NULL AND ${table.actualTree} IS NULL
      AND ${table.receipt} IS NOT NULL AND ${table.deliveryStatus} = CASE WHEN ${table.operationType} IN ('task_commit', 'integration', 'integration_commit') THEN 'not_requested' ELSE 'pending' END AND ${table.settledAt} IS NOT NULL)`),
  foreignKey({ name: 'git_operations_binding_fk', columns: [table.repositoryBindingId], foreignColumns: [repositoryBindings.id] }).onDelete('restrict'),
  foreignKey({ name: 'git_operations_feature_fk', columns: [table.projectId, table.featureId], foreignColumns: [features.projectId, features.id] }).onDelete('restrict'),
  foreignKey({ name: 'git_operations_run_fk', columns: [table.featureId, table.runId], foreignColumns: [runs.featureId, runs.id] }).onDelete('restrict'),
  foreignKey({ name: 'git_operations_attempt_fk', columns: [table.projectId, table.attemptId], foreignColumns: [attempts.projectId, attempts.id] }).onDelete('restrict'),
  foreignKey({ name: 'git_operations_binding_same_project_fk', columns: [table.projectId, table.repositoryBindingId], foreignColumns: [repositoryBindings.projectId, repositoryBindings.id] }).onDelete('restrict'),
  uniqueIndex('git_operations_project_id_id_unique').on(table.projectId, table.id),
  index('git_operations_project_feature_status_index').on(table.projectId, table.featureId, table.status),
  index('git_operations_project_run_index').on(table.projectId, table.runId),
  index('git_operations_project_intent_index').on(table.projectId, table.intentDigest),
]);

/** P05-7: private command associations and observed facts, append-only in migration v44. */
export const gitIntegrationCommands = sqliteTable('git_integration_commands', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  commandId: text('command_id').notNull(),
  operationId: text('operation_id').notNull(),
  requestDigest: text('request_digest').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [
  check('git_integration_commands_digest_check', sql`length(${table.requestDigest}) = 64 AND ${table.requestDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('git_integration_commands_time_check', sql`${table.createdAt} >= 1`),
  foreignKey({ columns: [table.projectId, table.operationId], foreignColumns: [gitOperations.projectId, gitOperations.id] }).onDelete('restrict'),
  uniqueIndex('git_integration_commands_command_index').on(table.projectId, table.commandId),
]);

export const gitIntegrationObservations = sqliteTable('git_integration_observations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  operationId: text('operation_id').notNull(),
  sequence: integer('sequence').notNull(),
  operationRevision: integer('operation_revision').notNull(),
  observation: text('observation').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [
  check('git_integration_observations_revision_check', sql`${table.operationRevision} >= 1 AND ${table.sequence} >= 1`),
  check('git_integration_observations_json_check', sql`json_valid(${table.observation}) AND json_type(${table.observation}) = 'object'`),
  check('git_integration_observations_time_check', sql`${table.createdAt} >= 1`),
  foreignKey({ columns: [table.projectId, table.operationId], foreignColumns: [gitOperations.projectId, gitOperations.id] }).onDelete('restrict'),
  uniqueIndex('git_integration_observations_operation_index').on(table.projectId, table.operationId, table.sequence),
]);

/**
 * P04-9 / F-001 Run 级持久派发认领（迁移 v33；ports/execution-dispatch.ts 契约）。
 *
 * 复用既有事实：`runs` 的 queued/控制/终态与不可变授权快照仍是业务事实，本表不保存
 * 第二套 Run 生命周期，也不按 Task 数量复制行。本表只补既有结构无法表达的 Run 级
 * 消费身份：
 * - 派发身份就是「同项目、同 Feature 的 Run」本身；`work_key` 仍只表示可跨重试的
 *   逻辑工作，既不是本表列也不是唯一键（新 Run 有独立派发身份）；
 * - `claim_version` 是该 Run 的受控认领代次（1 起），与 Task/Attempt 的
 *   `execution_version` 是不同计数器；显式 resume 只追加下一代认领，不重开终态
 *   Attempt 或修改既有认领行；
 * - `origin`/`resumed_from_*` 保存恢复关联：首代恒为 dispatch/v1，后续代必须是上一代
 *   已释放（停止已核对）的 resume/version+1（DDL CHECK + lineage trigger）；
 * - owner/host/claim_version/acquired_at 等身份列由 trigger 冻结；state 只允许
 *   held→released/quarantined、quarantined→released（不自动回收、不复用小代次）；
 * - 活动认领（held/quarantined）对同一 Run 唯一；终态 Run 不得再插入新认领。
 */
export const runDispatchClaims = sqliteTable('run_dispatch_claims', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 目标 Feature（必须与 Run 的 Feature 一致；同 Feature 派发身份由 Run 唯一表达）。 */
  featureId: text('feature_id').notNull(),
  /** 派发身份：已授权 Run 自身（重复入队复用同一 Run，因此代数在同一 Run 内递增）。 */
  runId: text('run_id').notNull(),
  /** Run 级受控认领代次（≥1；UNIQUE(project_id,run_id,claim_version)）。 */
  claimVersion: integer('claim_version').notNull(),
  /** 认领来源：dispatch=首次派发；resume=核对停止后的显式恢复代次。 */
  origin: text('origin').notNull(),
  /** 恢复关联：上一代认领身份（仅 resume；与 resumedFromClaimVersion 同时存在）。 */
  resumedFromClaimId: text('resumed_from_claim_id'),
  resumedFromClaimVersion: integer('resumed_from_claim_version'),
  /** Run 级消费者身份（不是 Task/Attempt 认领；Attempt 版本由 attempts 表记录）。 */
  ownerId: text('owner_id').notNull(),
  hostInstanceId: text('host_instance_id').notNull(),
  acquiredAt: integer('acquired_at').notNull(),
  leaseUntil: integer('lease_until').notNull(),
  /** 认领状态：held=当前持有；released=已核对停止；quarantined=待核对隔离。 */
  state: text('state').notNull().default('held'),
  /** 有界原因（隔离必须给出；不保存正文或凭据）。 */
  reason: text('reason'),
  /** 认领代次结束时刻（held 为 NULL；到期不等于已停止，不自动改写）。 */
  settledAt: integer('settled_at'),
}, (table) => [
  check('run_dispatch_claims_revision_check', sql`${table.revision} >= 1`),
  check('run_dispatch_claims_version_check', sql`typeof(${table.claimVersion}) = 'integer' AND ${table.claimVersion} >= 1`),
  check('run_dispatch_claims_origin_check', sql`${table.origin} IN ('dispatch', 'resume')`),
  check('run_dispatch_claims_state_check', sql`${table.state} IN ('held', 'released', 'quarantined')`),
  check('run_dispatch_claims_owner_check', sql`length(${table.ownerId}) BETWEEN 1 AND 128 AND length(${table.hostInstanceId}) BETWEEN 1 AND 128`),
  check('run_dispatch_claims_times_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 0
    AND typeof(${table.acquiredAt}) = 'integer' AND ${table.acquiredAt} >= 1
    AND typeof(${table.leaseUntil}) = 'integer' AND ${table.leaseUntil} >= ${table.acquiredAt}`),
  // 代次血缘：首代 dispatch/v1 无来源；resume 必须指向 version-1。
  check('run_dispatch_claims_generation_check', sql`
    (${table.origin} = 'dispatch' AND ${table.claimVersion} = 1
      AND ${table.resumedFromClaimId} IS NULL AND ${table.resumedFromClaimVersion} IS NULL)
    OR (${table.origin} = 'resume' AND ${table.resumedFromClaimId} IS NOT NULL AND ${table.resumedFromClaimVersion} IS NOT NULL
      AND ${table.resumedFromClaimVersion} = ${table.claimVersion} - 1)`),
  // 结算形状：held 未结束；隔离必须给出原因；released 的结束时间不早于认领时间。
  check('run_dispatch_claims_settlement_check', sql`
    (${table.state} = 'held' AND ${table.settledAt} IS NULL AND ${table.reason} IS NULL)
    OR (${table.state} = 'quarantined' AND ${table.settledAt} IS NOT NULL AND ${table.settledAt} >= ${table.acquiredAt}
      AND ${table.reason} IS NOT NULL AND length(${table.reason}) BETWEEN 1 AND 512)
    OR (${table.state} = 'released' AND ${table.settledAt} IS NOT NULL AND ${table.settledAt} >= ${table.acquiredAt}
      AND (${table.reason} IS NULL OR length(${table.reason}) BETWEEN 1 AND 512))`),
  foreignKey({
    name: 'run_dispatch_claims_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('restrict'),
  // 同 Feature：Run 必须是该 Feature 的 Run（runs_feature_id_id_unique）。
  foreignKey({
    name: 'run_dispatch_claims_feature_run_fk',
    columns: [table.featureId, table.runId],
    foreignColumns: [runs.featureId, runs.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'run_dispatch_claims_lineage_fk',
    columns: [table.projectId, table.resumedFromClaimId],
    foreignColumns: [table.projectId, table.id],
  }).onDelete('restrict'),
  uniqueIndex('run_dispatch_claims_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('run_dispatch_claims_run_version_unique').on(table.projectId, table.runId, table.claimVersion),
  // 活动认领唯一：隔离也占用身份，未核对停止前不能产生下一代或第二个消费者。
  uniqueIndex('run_dispatch_claims_active_run_unique')
    .on(table.projectId, table.runId)
    .where(sql`${table.state} IN ('held', 'quarantined')`),
  index('run_dispatch_claims_project_state_index').on(table.projectId, table.state, table.acquiredAt),
]);

/**
 * P04-9 / F-001 单执行槽位认领（迁移 v33；容量默认/开放为 1）。
 *
 * 槽位按 Run 消费者持有：每个活动 Run 至多一行活动槽位，不随 Task 数量重复分配；
 * 同一 slot_index 至多一个活动持有者。槽位只限制并行执行数量，不替代授权、
 * Task 依赖、global:execution/项目 Work/工作区租约或 Git 公共元数据短锁。
 * 旧 owner/版本不能续租或释放新持有者（身份列冻结 + 状态转换约束）。
 */
export const executionSlotClaims = sqliteTable('execution_slot_claims', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  /** 全局槽位序号（≥0；首版容量 1 只使用 0；>1 未获支持）。 */
  slotIndex: integer('slot_index').notNull(),
  featureId: text('feature_id').notNull(),
  runId: text('run_id').notNull(),
  /** 绑定的 Run 级认领（同项目复合外键；identity trigger 核对版本/owner/host）。 */
  claimId: text('claim_id').notNull(),
  claimVersion: integer('claim_version').notNull(),
  ownerId: text('owner_id').notNull(),
  hostInstanceId: text('host_instance_id').notNull(),
  acquiredAt: integer('acquired_at').notNull(),
  leaseUntil: integer('lease_until').notNull(),
  /** 槽位状态：held/quarantined/released（隔离不自动回收）。 */
  state: text('state').notNull().default('held'),
  reason: text('reason'),
  releasedAt: integer('released_at'),
}, (table) => [
  check('execution_slot_claims_revision_check', sql`${table.revision} >= 1`),
  check('execution_slot_claims_slot_check', sql`typeof(${table.slotIndex}) = 'integer' AND ${table.slotIndex} >= 0`),
  check('execution_slot_claims_version_check', sql`typeof(${table.claimVersion}) = 'integer' AND ${table.claimVersion} >= 1`),
  check('execution_slot_claims_state_check', sql`${table.state} IN ('held', 'quarantined', 'released')`),
  check('execution_slot_claims_owner_check', sql`length(${table.ownerId}) BETWEEN 1 AND 128 AND length(${table.hostInstanceId}) BETWEEN 1 AND 128`),
  check('execution_slot_claims_times_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 0
    AND typeof(${table.acquiredAt}) = 'integer' AND ${table.acquiredAt} >= 1
    AND typeof(${table.leaseUntil}) = 'integer' AND ${table.leaseUntil} >= ${table.acquiredAt}`),
  check('execution_slot_claims_settlement_check', sql`
    (${table.state} = 'held' AND ${table.releasedAt} IS NULL AND ${table.reason} IS NULL)
    OR (${table.state} = 'quarantined' AND ${table.releasedAt} IS NULL
      AND ${table.reason} IS NOT NULL AND length(${table.reason}) BETWEEN 1 AND 512)
    OR (${table.state} = 'released' AND ${table.releasedAt} IS NOT NULL AND ${table.releasedAt} >= ${table.acquiredAt}
      AND (${table.reason} IS NULL OR length(${table.reason}) BETWEEN 1 AND 512))`),
  foreignKey({
    name: 'execution_slot_claims_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'execution_slot_claims_claim_fk',
    columns: [table.projectId, table.claimId],
    foreignColumns: [runDispatchClaims.projectId, runDispatchClaims.id],
  }).onDelete('restrict'),
  // 一槽一持有者 / 一 Run 一活动槽位（held+quarantined 都占用，未核对前不回收）。
  uniqueIndex('execution_slot_claims_active_slot_unique')
    .on(table.slotIndex)
    .where(sql`${table.state} IN ('held', 'quarantined')`),
  uniqueIndex('execution_slot_claims_active_run_unique')
    .on(table.projectId, table.runId)
    .where(sql`${table.state} IN ('held', 'quarantined')`),
  index('execution_slot_claims_project_state_index').on(table.projectId, table.state, table.acquiredAt),
]);

/**
 * P04-9 / F-002 Run 入队意图（迁移 v34；Run 已授权即持久执行意图）。
 *
 * 本表只补既有列无法表达的入队事实：授权来源（start/retry/resume/
 * finalization_retry）、授权身份摘要与有界补扫顺序。Run 的 queued/控制/终态与
 * 不可变授权快照仍是唯一业务事实；本表不保存第二套状态机，也不按 Task 数量
 * 复制行。`(project_id, run_id)` 唯一：同 Run 重复入队复用同一意图，显式重试的
 * 新 Run 有独立意图（`work_key` 不是队列唯一键）。插入由 trigger 重核项目
 * active、Run queued、Batch 未终态与同项目/同 Feature/同 Batch 归属；身份列
 * 冻结，只允许插入（消费/认领由 F-003/F-004 的槽位与 Task 认领原语承担）。
 */
export const runDispatchIntents = sqliteTable('run_dispatch_intents', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  updatedAt: integer('updated_at').notNull(),
  featureId: text('feature_id').notNull(),
  batchId: text('batch_id').notNull(),
  runId: text('run_id').notNull(),
  /** 入队来源：首次授权/同父 Batch 重试/显式 resume/仅收尾重试。 */
  source: text('source').notNull(),
  /** 授权身份摘要（同身份异摘要即冲突；不是凭据）。 */
  authorizationDigest: text('authorization_digest').notNull(),
  /** 入队登记顺序（有界补扫键；不是 Run 创建时间的替代身份）。 */
  enqueuedAt: integer('enqueued_at').notNull(),
  /** 有界排队原因（不含正文/凭据）。 */
  reason: text('reason'),
}, (table) => [
  check('run_dispatch_intents_times_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 0
    AND typeof(${table.enqueuedAt}) = 'integer' AND ${table.enqueuedAt} >= 1`),
  check(
    'run_dispatch_intents_source_check',
    sql`${table.source} IN ('start', 'retry', 'resume', 'finalization_retry')`,
  ),
  check('run_dispatch_intents_digest_check', sql`length(${table.authorizationDigest}) = 64
    AND ${table.authorizationDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('run_dispatch_intents_reason_check', sql`${table.reason} IS NULL OR length(${table.reason}) BETWEEN 1 AND 512`),
  foreignKey({
    name: 'run_dispatch_intents_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('restrict'),
  // 同 Feature：Run 必须是该 Feature 的 Run（runs_feature_id_id_unique）。
  foreignKey({
    name: 'run_dispatch_intents_feature_run_fk',
    columns: [table.featureId, table.runId],
    foreignColumns: [runs.featureId, runs.id],
  }).onDelete('restrict'),
  // 一个 Run 只有一个入队意图（重复入队复用，不新增第二行）。
  uniqueIndex('run_dispatch_intents_run_unique').on(table.projectId, table.runId),
  index('run_dispatch_intents_project_enqueued_index').on(table.projectId, table.enqueuedAt),
]);

/**
 * P05-1 / F-002（迁移 v35）：一次性规划上下文（planning_contexts）。
 *
 * 只持久绑定一次规划的身份与依据事实（Project/Phase/Feature、规划 Run、
 * planning Task、candidateId、inputDigest、目标 revision/计划摘要、候选
 * Artifact/摘要与后续决策/应用关联）；预算/队列/Artifact 正文/审批正文一律复用
 * 既有设施。候选事实未生成时恒为 NULL（不伪造内容摘要）；身份列不可变、候选
 * 绑定与决策结果写一次（DDL 触发器防御纵深，Drizzle 不声明触发器，由迁移 SQL
 * 冻结）；同 Run 单候选、同 Feature 单活动规划（部分唯一索引）。
 */

/** P05-6 / F-002：冻结的集成计划；正文列和成果快照在适配器事务内一次写入。 */
export const integrationPlans = sqliteTable('integration_plans', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  phaseId: text('phase_id').notNull(),
  batchId: text('batch_id').notNull(),
  successorFeatureId: text('successor_feature_id').notNull(),
  targetBaseline: text('target_baseline').notNull(),
  inputDigest: text('input_digest').notNull(),
  mode: text('mode').notNull(),
  mergeOrder: text('merge_order').notNull(),
  approvedInputs: text('approved_inputs').notNull(),
  verificationScope: text('verification_scope').notNull(),
  strategySummary: text('strategy_summary').notNull(),
  integrationResult: text('integration_result'),
  status: text('status').notNull(),
  blockReasons: text('block_reasons').notNull().default('[]'),
  staleReasons: text('stale_reasons').notNull().default('[]'),
  frozenAt: integer('frozen_at'),
}, (table) => [
  check('integration_plans_revision_check', sql`${table.revision} >= 1`),
  check('integration_plans_target_baseline_check', sql`length(${table.targetBaseline}) IN (40, 64) AND ${table.targetBaseline} NOT GLOB '*[^0-9a-f]*'`),
  check('integration_plans_input_digest_check', sql`length(${table.inputDigest}) = 64 AND ${table.inputDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('integration_plans_mode_check', sql`${table.mode} IN ('reuse_single_predecessor', 'merge_multiple_predecessors')`),
  check('integration_plans_status_check', sql`${table.status} IN ('dependency_passed', 'integration_passed', 'stale', 'blocked')`),
  check('integration_plans_merge_order_json_check', sql`json_valid(${table.mergeOrder}) AND json_type(${table.mergeOrder}) = 'array'`),
  check('integration_plans_approved_inputs_json_check', sql`json_valid(${table.approvedInputs}) AND json_type(${table.approvedInputs}) = 'array'`),
  check('integration_plans_verification_scope_json_check', sql`json_valid(${table.verificationScope}) AND json_type(${table.verificationScope}) = 'array'`),
  check('integration_plans_strategy_json_check', sql`json_valid(${table.strategySummary}) AND json_type(${table.strategySummary}) = 'object'`),
  check('integration_plans_result_json_check', sql`${table.integrationResult} IS NULL OR (json_valid(${table.integrationResult}) AND json_type(${table.integrationResult}) = 'object')`),
  check('integration_plans_reasons_json_check', sql`json_valid(${table.blockReasons}) AND json_type(${table.blockReasons}) = 'array' AND json_valid(${table.staleReasons}) AND json_type(${table.staleReasons}) = 'array'`),
  check('integration_plans_times_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 1 AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= ${table.createdAt} AND (${table.frozenAt} IS NULL OR (typeof(${table.frozenAt}) = 'integer' AND ${table.frozenAt} >= ${table.createdAt}))`),
  foreignKey({ name: 'integration_plans_phase_fk', columns: [table.projectId, table.phaseId], foreignColumns: [phases.projectId, phases.id] }).onDelete('restrict'),
  foreignKey({ name: 'integration_plans_batch_fk', columns: [table.projectId, table.batchId], foreignColumns: [executionBatches.projectId, executionBatches.id] }).onDelete('restrict'),
  foreignKey({ name: 'integration_plans_successor_fk', columns: [table.projectId, table.phaseId, table.successorFeatureId], foreignColumns: [features.projectId, features.phaseId, features.id] }).onDelete('restrict'),
  uniqueIndex('integration_plans_project_id_id_unique').on(table.projectId, table.id),
  index('integration_plans_project_status_index').on(table.projectId, table.status, table.updatedAt, table.id),
]);

/** 前置 Feature 的不可变交付成果快照；不会跟随分支 HEAD 漂移。 */
export const integrationPredecessorSnapshots = sqliteTable('integration_predecessor_snapshots', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  planId: text('plan_id').notNull(),
  phaseId: text('phase_id').notNull(),
  featureId: text('feature_id').notNull(),
  predecessorOrdinal: integer('predecessor_ordinal').notNull(),
  dependencyPassed: integer('dependency_passed').notNull(),
  deliveryCommit: text('delivery_commit'),
  deliveryEvidenceId: text('delivery_evidence_id'),
  deliveryEvidenceDigest: text('delivery_evidence_digest'),
  coveredInputIds: text('covered_input_ids').notNull(),
  ancestorVerified: integer('ancestor_verified').notNull(),
}, (table) => [
  check('integration_snapshots_ordinal_check', sql`${table.predecessorOrdinal} >= 1`),
  check('integration_snapshots_created_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 1`),
  check('integration_snapshots_boolean_check', sql`${table.dependencyPassed} IN (0, 1) AND ${table.ancestorVerified} IN (0, 1)`),
  check('integration_snapshots_commit_check', sql`${table.deliveryCommit} IS NULL OR (length(${table.deliveryCommit}) IN (40, 64) AND ${table.deliveryCommit} NOT GLOB '*[^0-9a-f]*')`),
  check('integration_snapshots_evidence_shape_check', sql`(${table.deliveryCommit} IS NULL AND ${table.deliveryEvidenceId} IS NULL AND ${table.deliveryEvidenceDigest} IS NULL) OR (${table.deliveryCommit} IS NOT NULL AND length(${table.deliveryEvidenceId}) > 0 AND length(${table.deliveryEvidenceDigest}) = 64 AND ${table.deliveryEvidenceDigest} NOT GLOB '*[^0-9a-f]*')`),
  check('integration_snapshots_inputs_json_check', sql`json_valid(${table.coveredInputIds}) AND json_type(${table.coveredInputIds}) = 'array'`),
  foreignKey({ name: 'integration_snapshots_plan_fk', columns: [table.projectId, table.planId], foreignColumns: [integrationPlans.projectId, integrationPlans.id] }).onDelete('restrict'),
  foreignKey({ name: 'integration_snapshots_feature_fk', columns: [table.projectId, table.phaseId, table.featureId], foreignColumns: [features.projectId, features.phaseId, features.id] }).onDelete('restrict'),
  uniqueIndex('integration_snapshots_plan_feature_unique').on(table.planId, table.featureId),
  uniqueIndex('integration_snapshots_plan_ordinal_unique').on(table.planId, table.predecessorOrdinal),
  uniqueIndex('integration_snapshots_project_id_id_unique').on(table.projectId, table.id),
]);

export const phaseDeliveryCandidates = sqliteTable('phase_delivery_candidates', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  commandId: text('command_id').notNull(),
  phaseId: text('phase_id').notNull(),
  batchId: text('batch_id').notNull(),
  batchRevision: integer('batch_revision').notNull(),
  scopeDigest: text('scope_digest').notNull(),
  inputDigest: text('input_digest').notNull(),
  targetBaseline: text('target_baseline').notNull(),
  approvedInputs: text('approved_inputs').notNull(),
  leafFeatureIds: text('leaf_feature_ids').notNull(),
  mergeOrder: text('merge_order').notNull(),
  leaves: text('leaves').notNull(),
  verificationScope: text('verification_scope').notNull(),
  strategySummary: text('strategy_summary').notNull(),
  status: text('status').notNull(),
  integration: text('integration'),
  verification: text('verification'),
  workspacePreserved: integer('workspace_preserved').notNull().default(0),
}, (table) => [
  check('phase_delivery_candidates_revision_check', sql`${table.revision} >= 1`),
  check('phase_delivery_candidates_batch_revision_check', sql`${table.batchRevision} >= 1`),
  check('phase_delivery_candidates_digest_check', sql`length(${table.scopeDigest}) = 64 AND ${table.scopeDigest} NOT GLOB '*[^0-9a-f]*' AND length(${table.inputDigest}) = 64 AND ${table.inputDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('phase_delivery_candidates_target_baseline_check', sql`length(${table.targetBaseline}) IN (40, 64) AND ${table.targetBaseline} NOT GLOB '*[^0-9a-f]*'`),
  check('phase_delivery_candidates_status_check', sql`${table.status} IN ('pending_integration', 'awaiting_verification', 'reconciliation_required', 'blocked', 'ready_for_phase_approval')`),
  check('phase_delivery_candidates_inputs_json_check', sql`json_valid(${table.approvedInputs}) AND json_type(${table.approvedInputs}) = 'array'`),
  check('phase_delivery_candidates_features_json_check', sql`json_valid(${table.leafFeatureIds}) AND json_type(${table.leafFeatureIds}) = 'array' AND json_valid(${table.mergeOrder}) AND json_type(${table.mergeOrder}) = 'array' AND json_valid(${table.leaves}) AND json_type(${table.leaves}) = 'array'`),
  check('phase_delivery_candidates_scope_json_check', sql`json_valid(${table.verificationScope}) AND json_type(${table.verificationScope}) = 'array' AND json_valid(${table.strategySummary}) AND json_type(${table.strategySummary}) = 'object'`),
  check('phase_delivery_candidates_result_json_check', sql`(${table.integration} IS NULL OR (json_valid(${table.integration}) AND json_type(${table.integration}) = 'object')) AND (${table.verification} IS NULL OR (json_valid(${table.verification}) AND json_type(${table.verification}) = 'object'))`),
  check('phase_delivery_candidates_workspace_check', sql`${table.workspacePreserved} IN (0, 1)`),
  foreignKey({ name: 'phase_delivery_candidates_phase_fk', columns: [table.projectId, table.phaseId], foreignColumns: [phases.projectId, phases.id] }).onDelete('restrict'),
  foreignKey({ name: 'phase_delivery_candidates_batch_fk', columns: [table.projectId, table.batchId], foreignColumns: [executionBatches.projectId, executionBatches.id] }).onDelete('restrict'),
  uniqueIndex('phase_delivery_candidates_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('phase_delivery_candidates_command_unique').on(table.projectId, table.commandId),
  index('phase_delivery_candidates_batch_index').on(table.projectId, table.batchId, table.updatedAt, table.id),
]);
export const phaseDeliveryApprovals = sqliteTable('phase_delivery_approvals', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id').notNull().references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(1),
  updatedAt: integer('updated_at').notNull(),
  commandId: text('command_id').notNull(),
  actorId: text('actor_id').notNull(),
  phaseId: text('phase_id').notNull(),
  batchId: text('batch_id').notNull(),
  candidateId: text('candidate_id').notNull(),
  candidateRevision: integer('candidate_revision').notNull(),
  batchRevision: integer('batch_revision').notNull(),
  scopeDigest: text('scope_digest').notNull(),
  inputDigest: text('input_digest').notNull(),
  targetBaseline: text('target_baseline').notNull(),
  integrationCommitSha: text('integration_commit_sha').notNull(),
  integrationTreeSha: text('integration_tree_sha').notNull(),
  leafCommitShas: text('leaf_commit_shas').notNull(),
  integrationEvidenceId: text('integration_evidence_id').notNull(),
  integrationEvidenceDigest: text('integration_evidence_digest').notNull(),
  verificationEvidenceId: text('verification_evidence_id').notNull(),
  verificationEvidenceDigest: text('verification_evidence_digest').notNull(),
  budgetDigest: text('budget_digest').notNull(),
  budgetSummary: text('budget_summary').notNull(),
  codeSummary: text('code_summary').notNull(),
  planSummary: text('plan_summary').notNull(),
  summaryDigest: text('summary_digest').notNull(),
  status: text('status').notNull().default('approved'),
  invalidationReason: text('invalidation_reason'),
}, (table) => [
  check('phase_delivery_approvals_revision_check', sql`${table.revision} >= 1 AND ${table.candidateRevision} >= 1 AND ${table.batchRevision} >= 1`),
  check('phase_delivery_approvals_digest_check', sql`length(${table.scopeDigest}) = 64 AND ${table.scopeDigest} NOT GLOB '*[^0-9a-f]*' AND length(${table.inputDigest}) = 64 AND ${table.inputDigest} NOT GLOB '*[^0-9a-f]*' AND length(${table.budgetDigest}) = 64 AND ${table.budgetDigest} NOT GLOB '*[^0-9a-f]*' AND length(${table.summaryDigest}) = 64 AND ${table.summaryDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('phase_delivery_approvals_sha_check', sql`length(${table.targetBaseline}) IN (40, 64) AND ${table.targetBaseline} NOT GLOB '*[^0-9a-f]*' AND length(${table.integrationCommitSha}) IN (40, 64) AND ${table.integrationCommitSha} NOT GLOB '*[^0-9a-f]*' AND length(${table.integrationTreeSha}) IN (40, 64) AND ${table.integrationTreeSha} NOT GLOB '*[^0-9a-f]*'`),
  check('phase_delivery_approvals_evidence_digest_check', sql`length(${table.integrationEvidenceDigest}) = 64 AND ${table.integrationEvidenceDigest} NOT GLOB '*[^0-9a-f]*' AND length(${table.verificationEvidenceDigest}) = 64 AND ${table.verificationEvidenceDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('phase_delivery_approvals_json_check', sql`json_valid(${table.leafCommitShas}) AND json_type(${table.leafCommitShas}) = 'array' AND json_valid(${table.budgetSummary}) AND json_type(${table.budgetSummary}) = 'object' AND json_valid(${table.codeSummary}) AND json_type(${table.codeSummary}) = 'object' AND json_valid(${table.planSummary}) AND json_type(${table.planSummary}) = 'object'`),
  check('phase_delivery_approvals_status_check', sql`${table.status} IN ('approved', 'invalidated') AND (${table.status} = 'approved' AND ${table.invalidationReason} IS NULL OR ${table.status} = 'invalidated' AND ${table.invalidationReason} IS NOT NULL)`),
  foreignKey({ name: 'phase_delivery_approvals_phase_fk', columns: [table.projectId, table.phaseId], foreignColumns: [phases.projectId, phases.id] }).onDelete('restrict'),
  foreignKey({ name: 'phase_delivery_approvals_candidate_fk', columns: [table.projectId, table.candidateId], foreignColumns: [phaseDeliveryCandidates.projectId, phaseDeliveryCandidates.id] }).onDelete('restrict'),
  uniqueIndex('phase_delivery_approvals_project_id_id_unique').on(table.projectId, table.id),
  uniqueIndex('phase_delivery_approvals_command_unique').on(table.projectId, table.commandId),
  index('phase_delivery_approvals_candidate_index').on(table.projectId, table.phaseId, table.candidateId, table.updatedAt),
]);

export const planningContexts = sqliteTable('planning_contexts', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  projectId: text('project_id')
    .notNull()
    .references((): SQLiteColumn => projects.id, { onDelete: 'restrict' }),
  updatedAt: integer('updated_at').notNull(),
  phaseId: text('phase_id').notNull(),
  featureId: text('feature_id').notNull(),
  /** 规划 Run（Run.purpose=plan；创建时核验归属与用途）。 */
  runId: text('run_id').notNull(),
  /** 绑定的 planning Task（tasks.kind='planning'；同 Feature 复合外键）。 */
  planningTaskId: text('planning_task_id').notNull(),
  /** 稳定候选身份（随 Run 持久绑定；单候选）。 */
  candidateId: text('candidate_id').notNull(),
  /** 规划输入身份摘要（computePlanningInputDigest；64 位小写 hex）。 */
  inputDigest: text('input_digest').notNull(),
  /** 规划启动时的 Feature revision（应用候选时的 CAS 目标依据；≥1）。 */
  targetRevision: integer('target_revision').notNull(),
  /** 规划启动时的当前计划摘要（首次规划草稿为 NULL）。 */
  planDigest: text('plan_digest'),
  /** 候选 Artifact 引用（发布后写入且不可改；未生成为 NULL）。 */
  candidateArtifactId: text('candidate_artifact_id'),
  /** 候选 Artifact 内容摘要（与 candidate_artifact_id 同组写入/置空）。 */
  candidateContentHash: text('candidate_content_hash'),
  /** 候选语义摘要（批准绑定的 candidateDigest；发布后不可改）。 */
  candidateDigest: text('candidate_digest'),
  /** 候选审批摘要（供人工决策阅读；不是批准依据）。 */
  candidateSummary: text('candidate_summary'),
  /** 生命周期：open/candidate_published/applied/rejected/cancelled。 */
  status: text('status').notNull(),
  /** 人工决策（approved/rejected；未决策为 NULL）。 */
  decision: text('decision'),
  /** 决策原因（拒绝保留原因；不含正文/凭据）。 */
  decisionReason: text('decision_reason'),
  decidedAt: integer('decided_at'),
  /** 批准原子应用后的 Feature revision（拒绝/未决策为 NULL）。 */
  appliedRevision: integer('applied_revision'),
  appliedAt: integer('applied_at'),
}, (table) => [
  check('planning_contexts_times_check', sql`typeof(${table.createdAt}) = 'integer' AND ${table.createdAt} >= 0
    AND typeof(${table.updatedAt}) = 'integer' AND ${table.updatedAt} >= 0
    AND (${table.decidedAt} IS NULL OR (typeof(${table.decidedAt}) = 'integer' AND ${table.decidedAt} >= 1 AND ${table.decidedAt} >= ${table.createdAt}))
    AND (${table.appliedAt} IS NULL OR (typeof(${table.appliedAt}) = 'integer' AND ${table.appliedAt} >= 1 AND ${table.appliedAt} >= ${table.createdAt}))`),
  check('planning_contexts_status_check', sql`${table.status} IN ('open', 'candidate_published', 'applied', 'rejected', 'cancelled')`),
  check('planning_contexts_digest_check', sql`length(${table.inputDigest}) = 64 AND ${table.inputDigest} NOT GLOB '*[^0-9a-f]*'
    AND (${table.planDigest} IS NULL OR (length(${table.planDigest}) = 64 AND ${table.planDigest} NOT GLOB '*[^0-9a-f]*'))
    AND (${table.candidateDigest} IS NULL OR (length(${table.candidateDigest}) = 64 AND ${table.candidateDigest} NOT GLOB '*[^0-9a-f]*'))
    AND (${table.candidateContentHash} IS NULL OR (length(${table.candidateContentHash}) = 64 AND ${table.candidateContentHash} NOT GLOB '*[^0-9a-f]*'))`),
  check('planning_contexts_revision_check', sql`typeof(${table.targetRevision}) = 'integer' AND ${table.targetRevision} >= 1
    AND (${table.appliedRevision} IS NULL OR (typeof(${table.appliedRevision}) = 'integer' AND ${table.appliedRevision} >= 1))`),
  check('planning_contexts_candidate_shape_check', sql`
    (${table.status} = 'open' AND ${table.candidateArtifactId} IS NULL AND ${table.candidateContentHash} IS NULL
      AND ${table.candidateDigest} IS NULL AND ${table.candidateSummary} IS NULL)
    OR (${table.status} IN ('candidate_published', 'applied', 'rejected') AND ${table.candidateArtifactId} IS NOT NULL
      AND ${table.candidateContentHash} IS NOT NULL AND ${table.candidateDigest} IS NOT NULL AND ${table.candidateSummary} IS NOT NULL)
    OR ${table.status} = 'cancelled'`),
  check('planning_contexts_summary_check', sql`${table.candidateSummary} IS NULL OR length(${table.candidateSummary}) BETWEEN 1 AND 2000`),
  check('planning_contexts_decision_check', sql`
    (${table.decision} IS NULL AND ${table.status} IN ('open', 'candidate_published', 'cancelled'))
    OR (${table.decision} = 'approved' AND ${table.status} = 'applied' AND ${table.decidedAt} IS NOT NULL
      AND ${table.appliedRevision} IS NOT NULL AND ${table.appliedAt} IS NOT NULL)
    OR (${table.decision} = 'rejected' AND ${table.status} = 'rejected' AND ${table.decidedAt} IS NOT NULL
      AND ${table.appliedRevision} IS NULL AND ${table.appliedAt} IS NULL)`),
  check('planning_contexts_decision_reason_check', sql`${table.decisionReason} IS NULL OR length(${table.decisionReason}) BETWEEN 1 AND 512`),
  foreignKey({
    name: 'planning_contexts_candidate_artifact_fk',
    columns: [table.projectId, table.candidateArtifactId],
    foreignColumns: [artifacts.projectId, artifacts.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'planning_contexts_phase_fk',
    columns: [table.projectId, table.phaseId],
    foreignColumns: [phases.projectId, phases.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'planning_contexts_feature_fk',
    columns: [table.projectId, table.phaseId, table.featureId],
    foreignColumns: [features.projectId, features.phaseId, features.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'planning_contexts_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'planning_contexts_feature_run_fk',
    columns: [table.featureId, table.runId],
    foreignColumns: [runs.featureId, runs.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'planning_contexts_planning_task_fk',
    columns: [table.featureId, table.planningTaskId],
    foreignColumns: [tasks.featureId, tasks.id],
  }).onDelete('restrict'),
  // 单候选：同项目 candidateId 唯一；同一 Run 只有一个规划上下文。
  uniqueIndex('planning_contexts_candidate_unique').on(table.projectId, table.candidateId),
  uniqueIndex('planning_contexts_run_unique').on(table.projectId, table.runId),
  // 重复规划归属：同 Feature 同时只有一个活动规划（open/candidate_published）。
  uniqueIndex('planning_contexts_feature_active_unique').on(table.featureId)
    .where(sql`${table.status} IN ('open', 'candidate_published')`),
  index('planning_contexts_project_updated_index').on(table.projectId, table.updatedAt),
]);
