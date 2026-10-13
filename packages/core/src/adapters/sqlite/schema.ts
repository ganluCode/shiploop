/**
 * F-003 Drizzle SQLite Schema（adapters 层；drizzle-orm 只允许在本层被引用，
 * 见 scripts/check-boundaries.ts 与 test/typescript-build.test.ts）。
 *
 * 设计依据：core-design/03 §1-2、core-design/11 §3（projects/repository_bindings/
 * global_settings/project_settings）、§8（artifacts，本 Feature 子集）、§9（schema_migrations）。
 *
 * 本 Feature 仅建立 P01-2 存储闭环所需的最小六表；phases/features/tasks/runs/
 * attempts/sessions/chat 等后续表随对应功能以新迁移版本增加，不在本 Schema 出现。
 * P01-3 / F-006 起加入 state_events（迁移 v2），P02-2 / F-006 起加入
 * command_receipts（迁移 v3，见下方表注释）；P02-3 / F-007 起加入基线作用域
 * 四表（迁移 v4，见下方表注释）；P03-3 / F-002 起加入单 Feature 执行域三表
 * execution_batches/runs/batch_budget_revisions（迁移 v9，见下方表注释）。
 *
 * 与手写迁移 DDL（./migrations.ts）的一致性由 test/sqlite-schema-migrations.test.ts
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
    sql`(${table.receiptVersion} = 5 AND ${table.batchId} IS NULL AND ${table.runId} IS NULL) OR (${table.receiptVersion} = 6 AND ${table.operation} = 'execution.start' AND ${table.status} = 'accepted' AND ${table.scopeKind} = 'project' AND ${table.batchId} IS NOT NULL AND ${table.runId} IS NOT NULL AND ${table.operationId} = ${table.batchId} AND ${table.errorMessage} IS NULL AND ${table.errorDetails} IS NULL)`,
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
 * 边界与先例（与迁移 v6 同源，一致性由 test/sqlite-schema-migrations.test.ts 交叉核对）：
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
}, (table) => [
  check('phases_revision_positive_check', sql`${table.revision} >= 1`),
  check('phases_title_not_empty_check', sql`length(${table.title}) > 0`),
  check('phases_status_enum_check', sql`${table.status} IN ('open', 'closed', 'archived')`),
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
  /** F-008：首次受信通过的时间事实；元数据更新和旧状态重放不可改写。 */
  firstPassedAt: integer('first_passed_at'),
}, (table) => [
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
 *   一致性由 test/sqlite-schema-migrations.test.ts 交叉核对列/索引/外键，
 *   触发器行为由 test/p03-3-execution-schema.test.ts 失败用例覆盖）。
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
  // 恰一个 Feature 的不可变范围：featureIds 必须是恰含一个成员的 JSON 数组。
  // 缺失键时 json_type 为 NULL，必须以 IS 判定显式失败（CHECK 对 NULL 视为通过）。
  check(
    'execution_batches_scope_single_feature_check',
    sql`json_type(${table.scopeSnapshot}, '$.featureIds') IS 'array' AND json_array_length(${table.scopeSnapshot}, '$.featureIds') = 1`,
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
  // 同项目复合外键 + Phase/Feature 归属一致：伪造归属的直接 SQL 被拒绝。
  foreignKey({
    name: 'execution_batches_feature_phase_same_project_fk',
    columns: [table.projectId, table.phaseId, table.featureId],
    foreignColumns: [features.projectId, features.phaseId, features.id],
  }).onDelete('restrict'),
  uniqueIndex('execution_batches_project_id_id_unique').on(table.projectId, table.id),
  // runs(batch_id,feature_id) 复合外键目标：Run 必须落在单 Feature 范围内。
  uniqueIndex('execution_batches_id_feature_id_unique').on(table.id, table.featureId),
  // 同 Phase 有效活动 Batch 唯一（paused/interrupted 不是可绕过的终态）。
  uniqueIndex('execution_batches_active_phase_unique')
    .on(table.phaseId)
    .where(
      sql`${table.status} IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted')`,
    ),
]);

/**
 * P03-3 / F-002 Run（迁移 v9；core-design/11 §5 runs）。
 *
 * - 引用同项目 Batch 与 Feature，且 (batch_id,feature_id) 复合外键保证落在父 Batch
 *   的单 Feature 范围内；
 * - 保存 purpose、workKey、dispatchOrdinal（派发身份 UNIQUE(batch_id,work_key,
 *   dispatch_ordinal)）、输入快照与配置快照（不可变）、Run 上限（max_attempts_per_run/
 *   run_time_limit_ms，派发时冻结，精确范围归 ports/execution-budget 契约）与时间
 *   依据（started_at 设定后不可改，ended_at 收尾记录）；
 * - 条件唯一：同 Feature 有效活动 Run 唯一（部分唯一索引；活动集含
 *   paused/interrupted）；
 * - 不可变列由迁移 v9 触发器保护（同 executionBatches 注释）。
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
  // 单 Feature 范围：Run 的 Feature 必须是父 Batch 的同一 Feature。
  foreignKey({
    name: 'runs_batch_feature_same_scope_fk',
    columns: [table.batchId, table.featureId],
    foreignColumns: [executionBatches.id, executionBatches.featureId],
  }).onDelete('restrict'),
  // 派发身份唯一（重复派发在 DDL 级被拒绝；失败重试以递增 dispatch_ordinal 表达）。
  uniqueIndex('runs_receipt_identity_unique').on(table.projectId, table.batchId, table.id),
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
