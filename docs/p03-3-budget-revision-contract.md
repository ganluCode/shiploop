# P03-3 / F-009 批次预算显式修订契约

实施契约：`packages/core/src/application/execution-budget-revise.ts`（命令用例）、
`packages/core/src/ports/execution-store.ts`（修订原语输入校验与事件常量）、
`packages/core/src/adapters/sqlite/execution-store.ts`（`reviseBatchBudget` 短事务
CAS 原语）、`packages/core/src/ports/execution-budget.ts`
（`evaluateBatchBudgetRevision` 纯判定）、命令面接线
`packages/core/src/ports/commands.ts`（`execution.budget.revise`）与
`packages/core/src/application/command-service.ts`。
设计依据：core-design/04 §6.1（截止时间是持久绝对时间，暂停不自动延长，需要延期
由用户显式审批记录新预算版本；CAS 上限更新失败不派发；预算耗尽需人决定继续、
增额或结束）、core-design/08 §2（`reviseBatchBudget`：累计预算不随重启/子 Run
清零，增额需明确授权；模型不能调用新建 Batch 或增额命令来绕过授权预算）、
迁移 `v9`（`execution_batches` 当前预算三列 + `batch_budget_revisions` 不可变
修订历史表，F-002 已冻结；本 Feature 不新增迁移）。

## 1. 命令面（现有授权命令通道）

- 操作名 `execution.budget.revise`（`COMMAND_OPERATIONS` 白名单第 21 项）；
  能力位 `execution.budget.revise`（`APP_CAPABILITIES` 第 20 项）——与
  `execution.start` 分离的授权面：**增额/延期是一次新的明确用户授权**，启动执行
  的能力不蕴含修订预算的能力；`local-owner` 持全部能力，受限主体按测试装配显式
  构造。模型提出的理由或客户端自声明批准不能授予权限（缺能力 → `forbidden`，
  零写入零回执）。
- 更新类命令：信封顶层 `expectedRevision` 必填，是**目标 Batch 当前
  `budget_revision`** 的 CAS 期望（预算版本号；`budget_revision` 列承担 CAS）。
  payload 内出现 `revision`/`version` 即未知键。
- payload 冻结为 `{ batchId, budget, reason }`：
  - `batchId`：UUID v4（目标执行批次；归属与 CAS 在同一写事务内重核，跨项目
    `forbidden`/`ownership`）；
  - `budget`：修订后的**完整预算提案**（Batch + Run 两层；深校验复用
    `validateExecutionBudgetProposal` 权威校验器——deadline 已到达/过期即
    `deadline_passed` 拒绝，即「非法 deadline」；快照化后仅接受
    `schemaVersion=1`）；
  - `reason`：非空有界修订理由（trim 非空、≤512 字符；审计）。
- 严格未知键拒绝：`approvedBy`/`principalId`（批准主体由服务端可信身份绑定，
  `approvedBy=principalId`，不是请求输入）、`tokenUsed`/`costUsed`/`status`/
  `runsCreated`（用量与状态不是修订输入）、`maxCodeAttempts`/
  `taskMaxCodeAttempts`（Task 代码尝试上限不在本命令面，见 §5）。

## 2. 存储原语 `reviseBatchBudget`（短事务 CAS）

同会话同步写事务原语（`assertInTransaction`；已接线
`CommandTransaction.reviseBatchBudget`）。判定与写入顺序（任一步失败零写入）：

1. **输入校验**（ports `validateBatchBudgetRevisionInput`）：仅接受
   `projectId/batchId/expectedBudgetRevision/budgetSnapshot/approvedBy/reason`；
   `expectedBudgetRevision` 为 ≥1 安全整数；`approvedBy` 非空 ≤128 字符
   （服务端可信主体）；`reason` 非空 ≤512 字符；`budgetSnapshot` 经快照权威
   校验（`schemaVersion=1`）。
2. **归属核验**：Batch 缺失 `not_found`；跨项目 `ownership`（迁移 v9 复合
   外键兜底）。
3. **预算 CAS + 活动集**（全部先于任何写入）：`budget_revision ≠
   expectedBudgetRevision` → `conflict budget_revision_stale`（details 携带
   expected/actual）；终态 Batch（活动集与迁移 v9 条件唯一索引同源，
   `paused`/`interrupted` 不是可绕过的终态，**暂停中可增额**）→ `conflict
   batch_not_active`——授权已关闭，新工作需新授权（新 Batch），修订不是复活
   终态批次的通道。
4. **仅增额或延期**（`evaluateBatchBudgetRevision` 纯函数单调判定，携带累计
   用量防御）：计数维度（`maxRuns`/`maxTotalAttempts`/`maxRuntimeStarts`/
   `maxNoProgressRuns`）、绝对 `deadlineUtcMs` 与 Run 层上限
   （`maxAttemptsPerRun`/`runTimeLimitMs`）一律 `proposed ≥ current`（不回退）；
   可选资源总额（`maxTokenTotal`/`maxCostTotal`）**不可中途引入或移除**，只在
   已设上限上增额（移除 = 无界增额、引入 = 收紧，都不属于显式增额/延期）；
   `proposed < 已用计数` → `limit_below_used`（防御纵深：持久计数超上限的
   不一致状态也不放行）。违规 `conflict revision_not_increased`（或
   `limit_below_used`），零写入。
5. **同事务原子写入**：单语句条件 `UPDATE execution_batches SET
   budget_snapshot=?, budget_revision=budget_revision+1, deadline_at=?,
   revision=revision+1, updated_at=? WHERE … AND budget_revision=expected AND
   status IN (活动集)`（CAS 于预算版本与活动状态双条件；串行化窗口内变化以
   当前行重判 `budget_revision_stale`/`batch_not_active`），随后追加不可变
   修订行 `batch_budget_revisions`（`version=expected+1`、`approved_by`、
   `reason`、新预算快照与 deadline；`UNIQUE(batch_id,version)`）。任一步失败
   整组回滚——**失败无部分更新**（组合失败测试：预占 v2 修订身份后整组回滚）。
   累计计数（`runs_created`/`attempts_created`/`runtime_starts`/
   `no_progress_runs`）与身份/范围/配置快照列不触碰（迁移 v9 触发器保护
   不可变列；`budget_snapshot`/`budget_revision`/`deadline_at`/`status`/
   计数列自 v9 起即为可演进列）。

## 3. 命令用例编排（application/execution-budget-revise）

无事务外 I/O（与 `task.strategy.update` 同一形态）；在调用方同一 BEGIN
IMMEDIATE 短写事务内：

1. 父级项目把关（缺失/不可见统一 `forbidden`，不泄漏存在性）。
2. 预算深校验（提案权威校验器 + `referenceNowUtcMs`：过期 deadline 即
   `invalid_input` 抛出，零写入零回执）。
3. 目标 Batch 读取：缺失 `not_found`、跨项目 `forbidden`（抛出）。
4. **写入之前的确定性业务拒绝固化 rejected 回执**（零业务写入）：
   `budget_revision_stale` / `batch_not_active` / `revision_not_increased` /
   `limit_below_used`（details 键限受控白名单 reason/expectedRevision/
   actualRevision/entityType）。
5. 调用存储原语（预检与写入在同一事务内，无竞争窗口；原语写入前重核全部
   守卫为防御纵深）。**此处不捕获 conflict**：预检之后的任何失败都发生在
   写入阶段（写后异常只能回滚，不能吞成 rejected；客户端可换 commandId 重试）。
6. 追加脱敏事件 `execution.budget.revised`（payload 恒 `{revised:true}`，聚合
   `execution_batch`，aggregateRevision=修订后 Batch 行 revision；不携带预算
   数值/理由正文/批准主体——白名单与 payload 形状在 ports/events.ts 冻结）。
7. completed 回执（结果 ≤16KB）：`batchId`/`budgetRevision`（新版本）/
   `approvedBy`（=principalId）/`reason`/`revisedAt` + `previous`（上一版本号、
   修订前预算快照、deadline）与 `revised`（新版本号、修订后预算快照、
   deadline）——**审计可核对批准主体、时间、理由及修订前后值**。

幂等由命令面承担：同 `commandId` 完整重放返回原回执（`replayed:true`），不产生
第二条修订行或事件；不同参数复用 `commandId` 由 `requestDigest` 冲突拒绝。
真实 SQLite CAS 竞争仅一个成功（BEGIN IMMEDIATE 写锁串行化 + 预算版本 CAS；
竞争测试：并发连接 busy 拒绝后重试旧 revision → `budget_revision_stale`）。

## 4. 持久性不变量（测试断言事实）

- **保留此前授权预算及 Run/Task/输入快照**：修订只更新 Batch 当前预算三列；
  `runs` 行（含派发冻结上限 `max_attempts_per_run`/`run_time_limit_ms`、
  `input_snapshot`/`work_key`）与 `tasks` 行逐字节不变；累计计数不清零。
- **仅增额不自动启动或恢复 Run**：修订不创建 Run、不递增 `runtime_starts`、
  不写派发事件、不唤醒调度器；运行中（Batch running + 活动 Run）增额成功后
  Run 状态与派发事件计数不变。延期后新派发/新启动仍由 F-005/F-007 各自的
  显式通道与预算判定决定（修订不代执行）。
- 修订历史行不可变：`batch_budget_revisions` UPDATE/DELETE 一律触发器拒绝
  （v9）；历史 v1..v13 SQL/checksum 不变（本 Feature 无新迁移）。
- 暂停重开、重启恢复：修订不重置任何计数、不改写时间依据（`started_at`/
  `ended_at` 不触碰）。

## 5. Task 代码尝试上限：唯一显式通道

- Task `maxCodeAttempts` 的显式调整**只经 `task.strategy.update` 策略 CAS 通道**
  （完整 `executionConfig` 副本整体替换；`task.strategy.write` 能力 + Task 自身
  revision CAS + `task_edit` 来源 + `task.strategy.updated` 脱敏事件与回执——
  同样的授权与审计约束）；预算修订命令面不含任何 Task 上限字段（未知键拒绝）。
- **不得静默增额**：更新默认配置（settings `executionLimits.maxCodeAttempts`）
  不追溯既有 Task 副本（F-001 捕获语义；预占以 Task 副本为权威）；换 Run 不清
  Task 双计数（`attempt_counter`/`code_attempts_used` 跨 Run 累计递增，F-006）；
  活动执行输入保护下策略热改被拒（`active_execution_inputs`，P03-2/F-001 守卫）。

## 6. 范围边界（本 Feature 不实现）

查询面已由 **F-010 落地**（`execution.budget.get` / `execution.budget.revisions`，
见 `docs/p03-3-execution-budget-query-contract.md`：Batch/修订历史只读查询、
有界分页与受控游标）、Host/CLI 入口（F-011/F-012：
HostClient 方法与 CLI 子命令；命令已可经既有 POST /v1/commands 通用路由提交）、
暂停/取消/恢复命令（后续控制面任务）、token/cost 实际用量结算（结算行无用量
列，F-008 边界不变）、Scheduler/Runner 装配与唤醒（后续任务）。修订能力位不
代表已具备上述能力。

## 7. 验证记录（F-009）

- 新增：`test/p03-3-budget-revision.test.ts`（19 用例：授权/归属/输入面矩阵、
  短事务原子提交与组合回滚、运行中增额不启动恢复、单调/降额/limit_below_used
  拒绝、终态批次拒绝、幂等重放与 commandId 冲突、真实 SQLite CAS 竞争、修订
  历史不可变、审计前后值、Task 上限唯一通道与不可静默增额）、
  `test/p03-3-execution-budget.test.ts` 追加 `evaluateBatchBudgetRevision` 纯
  判定 6 用例。
- 受影响冻结面同步：commands-contract（第 21 项操作与第 20 项能力）、
  events-contract（`execution.budget.revised` 白名单）、host-lifecycle 与
  host-app-routes（接线宣告清单）、docs-p03-3-execution-start-contract
  （Host/Core 命令清单交叉核对）。
