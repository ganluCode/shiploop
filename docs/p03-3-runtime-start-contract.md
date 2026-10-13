# P03-3 / F-007 Runtime 启动额度预占契约

实施契约：`packages/core/src/ports/execution-store.ts`（记录形态与输入校验）、
`packages/core/src/adapters/sqlite/execution-store.ts`（迁移 v12 同事务原语）、
迁移 `v12`（`packages/core/src/adapters/sqlite/migrations.ts`）。
设计依据：core-design/04 §6/§6.1（SDK 启动前预占 runtimeStart 额度、启动失败可
保守计数不盲目退还、预算耗尽停止新认领/派发、计数上限已达可让现有执行身份收尾、
deadline 按受控取消流程停止、所有计数与对象创建在同一事务、重启不从进程变量
清零）、core-design/11 §5（执行域表）与 §10（预算耗尽不伪造完成）。

## 1. 迁移 v12 持久事实

- 新建 `runtime_start_reservations` 启动预占账本表：
  - 幂等启动身份 `UNIQUE(project_id, start_key)`（start_key 为受信 Core 生成的
    稳定键，≤128 字符；启动身份属于其获准 Run——跨 Run 复用同身份在 DDL 级拒绝）；
  - 同项目复合外键链：`(project_id,batch_id)→execution_batches`、
    `(project_id,batch_id,run_id)→runs`，全部 `ON DELETE RESTRICT`；
  - 账本行只是**预占证据**：无 token/cost 用量列、无 `sdk_started`/`outcome`/
    进程列（预占不携带也不自报实际用量或真实 SDK 已启动事实）。
- 本迁移不建 `sessions`/`recording_manifests` 等会话记录表、不建
  `workspace_leases`/通知表；`state_events` 不加 runtime 启动事件类型
  （`execution.run.dispatched` 语义仍为派发而非已启动）。
- 历史 v1..v11 SQL/checksum 不变（追加式迁移）。

## 2. 事务原语（受信 Core 内部面；不经命令路由暴露）

全部为同会话同步写事务原语（`assertInTransaction`，与 F-005/F-006 原语同一
组合面；已接线 `CommandTransaction.reserveRuntimeStart / getRuntimeStartReservation`）：

### 2.1 `reserveRuntimeStart`（SDK 启动前预占）

判定与写入顺序（任一步失败零写入）：

1. **输入校验**（ports `validateRuntimeStartReservationInput`）：仅接受
   `projectId/batchId/runId/startKey`；`tokenUsed`/`costUsed`/`sdkStarted`/
   `outcome`/`runner`/`classification` 等执行域字段都是未知键（预占不携带用量
   与已启动事实，Runtime 启动也无分类语义——非法输入在任何 SQL 之前拒绝）。
2. **归属核验**（同事务绑定参数查询；复合外键兜底）：预占只能关联**当前获准
   Run 的受信执行身份**——Batch/Run 缺失 `not_found`；跨项目或 Run 不属于
   声明的 Batch `ownership`。
3. **幂等身份去重先于控制状态与额度**：同 `(project,startKey)` 且同 Batch/Run
   重放返回既有记录（不重复计数——即使 Run/Batch 已进入终态，重放仍幂等返回，
   计数上限不撤销已有执行身份）；同身份绑定其他 Batch/Run（跨 Run/过期身份）
   `conflict start_key_reused`。
4. **有效控制状态**（活动集与迁移 v9 条件唯一索引同源，`paused/interrupted`
   不是可绕过的终态）：终态 Batch `conflict batch_not_active`、终态 Run
   `conflict run_not_active`。
5. **额度判定（全部先于任何写入）**，任一命中即 `conflict budget_exhausted`
   （details.reasons 携带 layer/dimension/limit/used）：
   - Batch 层：`runtime_starts >= budget_snapshot.batch.maxRuntimeStarts`
     （dimension `maxRuntimeStarts`；used==limit 恰好拒绝、used==limit-1 放行，
     计数不溢出；当前批准预算快照为权威）；
   - `now >= deadlineUtcMs`（dimension `deadlineUtcMs`，恰好到达即拒绝）——
     deadline 给出**必须受控停止的原因**：拒绝新启动但不清空占用（已落账本行
     与计数保留）、不假称进程已停止（无进程状态字段）。
6. **同事务原子写入**：`execution_batches.runtime_starts+1`（条件 UPDATE 仅
   活动态命中）与账本行插入一次调用全部生效。调用方在同一 BEGIN IMMEDIATE 内
   组合后续写入，任何后续失败整组回滚（组合事务测试覆盖）。

### 2.2 启动失败与准备失败的区分（保守计数）

- **仅创建 Run、预览、准备输入或最终检查不增加 runtimeStarts**：F-005
  `execution.start` 创建 Batch/Run 时 `runtime_starts` 恒 0；`execution.preview`
  与 `execution.input.prepare` 为只读/制品路径不触碰执行域计数；基线最终检查
  不进入执行域。
- **准备前失败**：总 Attempt 可保留（F-006 预占已计入 attempts_created 与
  Task 双计数）但 Runtime 启动数为零——未经本边界的任何失败路径不产生
  runtime_starts。
- **通过本边界预占后启动失败**：保守保留一次启动计数——本契约**不提供任何
  退额原语**（CommandTransaction 无 release/refund/unreserve 类方法），账本行
  与计数是持久事实；不伪造 token/cost 用量或真实 SDK 已启动事实（账本无用量
  列，账本行存在不代表 SDK 已成功启动）。

### 2.3 读取原语

`getRuntimeStartReservation`（同项目同 Run 同启动身份，无则 null）。剩余额度 =
`budget_snapshot.batch.maxRuntimeStarts` 与持久 `runtime_starts` 合并计算，不由
内存快照回答；数据库关闭重开一致。

## 3. 持久性不变量（测试断言事实）

- 竞争预占（真实 SQLite）：`maxRuntimeStarts=N` 时第 N+1 个不同启动身份被拒
  （budget_exhausted），先到先得、计数不溢出。
- 重放幂等：同身份重放返回同一记录 ID，不重复计数；重开数据库后计数/账本/
  幂等语义一致。
- 回滚一致：同事务组合写入失败整组回滚（runtime_starts 与账本行都不落库）。
- 取消、失败、数据库重开不清计数；Batch/Run 历史输入/范围/配置快照逐字节不变。
- 拒绝（budget_exhausted/conflict/not_found/ownership）路径零写入。

## 4. 范围边界（本 Feature 不实现）

- 不实现 Runner、停止管理、会话记录、token/cost 实际用量结算（P03-4 与后续
  任务）；普通测试仅记录受信启动边界调用，不调用 Pi、网络或模型。
- Run 结果结算与无进展计数（F-008，见 `docs/p03-3-run-outcome-settlement-contract.md`）；
  批次预算显式修订已由 F-009 建设（`execution.budget.revise`，见
  `docs/p03-3-budget-revision-contract.md`；修订仅增额或延期且不自动启动或
  恢复 Run，不触碰本契约的启动预占账本与 runtime_starts 计数）；只读查询面
  （F-010）由后续任务建设；F-007 本身不新增命令操作、事件类型或回执形态
  （命令面/能力面不含任何 runtime start/reserve 操作——客户端与模型没有
  自报入口）。
