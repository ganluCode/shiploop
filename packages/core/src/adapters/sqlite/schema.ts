/**
 * F-003 Drizzle SQLite Schema（adapters 层；drizzle-orm 只允许在本层被引用，
 * 见 scripts/check-boundaries.ts 与 test/typescript-build.test.ts）。
 *
 * 设计依据：core-design/03 §1-2、core-design/11 §3（projects/repository_bindings/
 * global_settings/project_settings）、§8（artifacts，本 Feature 子集）、§9（schema_migrations）。
 *
 * 本 Feature 仅建立 P01-2 存储闭环所需的最小六表；phases/features/tasks/runs/
 * attempts/sessions/chat 等后续表随对应功能以新迁移版本增加，不在本 Schema 出现。
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
 *   （设计 11 §1）+ 双向 FK 存在性与 ON DELETE RESTRICT；“绑定属于同一项目”的不变量
 *   由存储端口写入路径在事务内原子校验（F-007/F-008 回归覆盖），本 DDL 不放宽；
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
