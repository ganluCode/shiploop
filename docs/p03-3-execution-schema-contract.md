# P03-3 执行域 Schema 契约（F-002：单 Feature ExecutionBatch、Run 与预算修订记录迁移 + Drizzle Schema）

状态：已实现（F-002 范围：迁移 v9 与 Drizzle Schema；存储原语/命令/预占/结算随 F-003..F-010 落地）。
权威实现：`packages/core/src/adapters/sqlite/migrations.ts`（迁移 v9 DDL 与不可变内容触发器）、
`packages/core/src/adapters/sqlite/schema.ts`（Drizzle Schema）。
守护测试：`test/p03-3-execution-schema.test.ts`、`test/sqlite-schema-migrations.test.ts`、
`test/sqlite-migration-runner.test.ts`、`test/docs-p03-3-execution-schema-contract.test.ts`。

F-003 接续登记：追加迁移 v10 扩展既有命令回执关联；历史 v1..v9 checksum 不变。
Work 回执不虚建基线实体，使用真实 Batch/Run 外键；v9 历史升级测试继续固定到 v9。
详见 [Work accepted 回执契约](p03-3-work-command-receipts-contract.md)。

## 1. 迁移接续（acceptance 1）

- 从前序真实最新迁移 **v8** 继续追加 **v9**；历史 v1..v8（含 v1..v5 与已合入前序 v6/v7/v8）
  SQL 与 checksum 逐字节不变（冻结摘要断言于 `test/p03-3-execution-schema.test.ts`）。
- 升级路径（全部真实 SQLite 验证既有数据逐字段保留）：
  - 空库 → v9：三表建立且为空；
  - 真实 P02 v5 数据库（项目/绑定/全局与项目配置/元数据事件/Artifact/completed 与
    accepted 回执/基线授权·操作·检查·占用行）→ v9：数据与事件序列保留；
  - 前序最新 v8 库（计划结构 Phase/Feature/Task/依赖 + approvals 决策行）→ v9：保留。
- v9 失败整组回滚（无半张表/半条触发器/半条迁移记录），修复后从一致 v8 继续；
  高版本（v10 探针）与 checksum 漂移拒写在 v9 清单下继续有效（不自动降级）。

## 2. 表设计（core-design/11 §5 的单 Feature 子集）

| 表 | 职责 | 关键列 |
|---|---|---|
| `execution_batches` | 一次用户授权的单 Feature 执行批次：不可变范围 + 输入配置依据 + 有限初始预算 + 累计计数 | `phase_id`、`feature_id`、`scope_snapshot`、`config_snapshot`、`status`、`budget_revision`、`budget_snapshot`、`runs_created`/`attempts_created`/`runtime_starts`/`no_progress_runs`、`deadline_at`、`reason` |
| `runs` | 对单 Feature 的一次派发：目的、派发身份、输入快照、Run 上限与时间依据 | `batch_id`、`feature_id`、`purpose`、`input_snapshot`、`config_snapshot`、`status`、`scope_digest`、`work_key`、`dispatch_ordinal`、`max_attempts_per_run`、`run_time_limit_ms`、`attempts_created`、`started_at`/`ended_at` |
| `batch_budget_revisions` | 批次预算初始与历史快照（含操作者、理由、预算、时间），修订身份唯一 | `batch_id`、`version`、`budget_snapshot`、`deadline_at`、`approved_by`、`reason` |

- Batch **恰一个 Feature** 的不可变范围：`feature_id` NOT NULL + `scope_snapshot` CHECK 强制
  `featureIds` 为恰含一个成员的 JSON 数组（缺失键以 `IS 'array'` 显式失败，不借 CHECK 对
  NULL 的放行）；成员标题/描述、依赖内容、范围外已完成依赖证据、用途与输入摘要随 F-004
  preview 形态在 `scope_snapshot` 内扩展（DDL 只保 JSON 对象底线，完整结构归端口契约）。
- **有限初始预算**：`budget_snapshot`（JSON 对象，形态 = ports/execution-budget
  `schemaVersion=1` 契约，含 batch 四计数上限 + deadline + 可选 token/cost 与 run 上限）、
  `budget_revision`（≥1）与 `deadline_at`（≥1，绝对 UTC 毫秒）另列（设计 11 §10）。
  数值范围（1..1000 等）不进 DDL：属 F-001 实施契约值（设计未给定、仍待核对），精确
  校验由 ports 契约承担，DDL 只保正整数底线，避免把待确认范围冻结进不可变迁移。
- Run **上限与时间依据**：`max_attempts_per_run`/`run_time_limit_ms`（派发时从预算契约
  冻结到 Run 行——旧 Run 快照不随后续预算修订改变）；`started_at`（时间依据，设定后
  不可改；`runTimeLimitMs` 从此计）与 `ended_at`（收尾记录）。
- 累计计数非负（负计数 DDL 级拒绝），不随成功、取消或重启清零（结算原语属 F-008）。

## 3. 约束与条件唯一（acceptance 3）

- 外键（全部 ON DELETE RESTRICT）：缺失父 Batch、跨项目引用在 DDL 级被拒绝——
  `execution_batches(project_id,phase_id,feature_id) → features(project_id,phase_id,id)`
  （同时保证 phase 归属与 Feature 一致）、`runs(project_id,batch_id) →
  execution_batches(project_id,id)`、`runs(project_id,feature_id) → features(project_id,id)`、
  `runs(batch_id,feature_id) → execution_batches(id,feature_id)`（Run 落在父 Batch 的单
  Feature 范围内）、`batch_budget_revisions(project_id,batch_id) →
  execution_batches(project_id,id)`（修订记录关联同项目 Batch）。
- 重复派发身份拒绝：`UNIQUE(batch_id, work_key, dispatch_ordinal)`；失败重试以递增
  `dispatch_ordinal` 表达，不退还计数（结算语义属 F-008）。
- 修订身份唯一：`UNIQUE(batch_id, version)`。
- 条件唯一（部分唯一索引，设计 11 §10）：
  - 同 Feature 有效活动 Run 唯一（`runs_active_feature_unique`）；
  - 同 Phase 有效活动 Batch 唯一（`execution_batches_active_phase_unique`）；
  - 活动集 = `queued/running/pausing/paused/cancelling/interrupted`——**paused（暂停）与
    interrupted（归属待核对）不是可绕过的终态**，不参与「释放活动位」；只有
    succeeded/failed/cancelled 历史终态退出活动唯一。
- 状态枚举（02 §3/§8 完整生命周期）CHECK 冻结：两表同枚举。

## 4. 不可变内容（acceptance 2/4；触发器 + 失败用例）

Drizzle 无法表达触发器；不可变内容由迁移 v9 触发器承载（列/索引/外键一致性仍由
`test/sqlite-schema-migrations.test.ts` 经 pragma 与 `getTableConfig` 交叉核对）：

- `execution_batches_immutable_columns_update`：id/created_at/project_id/phase_id/
  feature_id/scope_snapshot/config_snapshot UPDATE 覆盖拒绝（当前预算、状态、累计
  计数、reason 在 Batch 行正常演进）；
- `runs_immutable_columns_update`：id/created_at/project_id/batch_id/feature_id/
  purpose/input_snapshot/config_snapshot/scope_digest/work_key/dispatch_ordinal/Run 上限
  UPDATE 覆盖拒绝；`started_at` 可从 NULL 首次设定，设定后不可改写或清空（时间依据
  保持不变）；
- `batch_budget_revisions_immutable_update` / `batch_budget_revisions_immutable_delete`：
  整行 UPDATE/DELETE 一律拒绝——**初始（version=1）与历史
  预算快照不可被当前预算更新覆盖**；当前预算更新 = Batch 行 budget_snapshot/
  budget_revision/deadline_at 演进 + 新版本修订行追加，旧行逐行留存（审计可核对
  修订前后值）。

## 5. 相对设计 11 的登记决策（请求核对；不改领域语义）

- `execution_batches.phase_id` 设计 11 列为可空；P03-3 单 Feature 批次恒取所属 Feature
  的 Phase（NOT NULL），使「同 Phase 活动 Batch 唯一」可由部分唯一索引保证；多 Feature
  跑批属后续路线，届时以新迁移扩展，不回改本迁移。
- `execution_batches.feature_id` 与 `runs.max_attempts_per_run`/`run_time_limit_ms` 为
  设计 11 §5 未列的显式列：前者承载「恰一个 Feature」的范围身份，后者承载 acceptance
  要求的 Run 上限（派发时冻结），与 ports/execution-budget `RunBudgetLimits` 同源。
- `scope_snapshot.featureIds` 单成员 CHECK 与不可变触发器为设计 11 §10「不可变内容校验
  须有失败用例」的 DDL 承载；`batch_budget_revisions` 含创建时的初始版本行（version=1），
  使「初始快照」有独立不可变证据。
- 不建计划/配置业务版本表（设计 11 §3/§5 明确不建设范围：候选计划存制品，配置仅存
  当前值）；不因此迁移引入任何 PlanRevision/configuration_revisions 语义。

## 6. 范围边界（本 Feature 不实现）

- 仅新增本项三表所需持久数据：不建完整 `attempts`、`sessions`/`chat_turns`/
  `recording_manifests`、Worktree 占用（`workspace_leases`）或通知表
  （`notification_channels`/`notification_deliveries`，设计 11 §6/R2），
  也不建 `verification_batches`/`check_definitions`/`check_results`/`operations`；
  `state_events` 不加 run_id/task_id/attempt_id 列（随其关联表同迁移加入）。
- 无存储写原语、命令/回执扩展、prepare/start/预占/结算/修订/查询——分别属
  F-003..F-010；本项只保证 Schema 承载与其 DDL 级不变量。

## 7. 验证记录（F-002）

- 新增：`test/p03-3-execution-schema.test.ts`（10 用例：迁移接续/冻结 checksum/空库/
  真实 P02 v5 数据升级/前序 v8 库升级/失败整组回滚/高版本与漂移拒写、外键与跨项目/
  单范围负例、负计数/非法状态/非法 JSON/单成员范围/重复派发与修订身份负例、活动 Run
  与活动 Batch 条件唯一（含 paused/interrupted 不可绕过）、不可变内容失败矩阵）。
- 受影响回归：`test/sqlite-schema-migrations.test.ts`（Drizzle↔DDL 列/索引（含部分
  索引）/CHECK/外键交叉核对 + 三表往返）、`test/sqlite-migration-runner.test.ts`、
  `test/p03-1-plan-structure-storage.test.ts`、`test/sqlite-baseline-store.test.ts`、
  `test/sqlite-artifact-store.test.ts`、p03-1/p03-2 命令与输入边界守护（执行域表为
  空表、无执行实体行）、`docs/p02-4-acceptance-contract.md` 与
  `docs/p03-3-execution-budget-contract.md` 迁移登记同步。
- 完整门禁（scope=full）：`npm run verify`（test + typecheck + build）与
  `npm run check:boundaries` 结果见 progress.md 与提交记录。
