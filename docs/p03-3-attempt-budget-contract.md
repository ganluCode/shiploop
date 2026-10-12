# P03-3 / F-006 Task 尝试预算预占与代码尝试分类记账契约

实施契约：`packages/core/src/ports/execution-store.ts`（记录形态与输入校验）、
`packages/core/src/adapters/sqlite/execution-store.ts`（迁移 v11 同事务原语）、
迁移 `v11`（`packages/core/src/adapters/sqlite/migrations.ts`）。
设计依据：core-design/04 §6/§6.1（分层预算、计数与对象创建同事务、重启不清零、
基础设施失败不消耗代码返工预算）、core-design/11 §3.1（tasks.attempt_counter /
code_attempts_used）与 §5（执行域表）。

## 1. 迁移 v11 持久事实

- `tasks` 追加执行域累计计数列（既有行默认 0）：
  - `attempt_counter`：Task **总尝试计数**（含基础设施分类尝试）；
  - `code_attempts_used`：**代码尝试计数**（首次代码执行与代码修复）；
  - DDL 内联 CHECK 底线：两列非负且 `code_attempts_used <= attempt_counter`
    （ALTER ADD COLUMN 不能具名，精确范围校验属 ports 契约）。
- 新建 `task_attempt_reservations` 预占账本表：
  - 幂等身份 `UNIQUE(project_id, task_id, attempt_key)`（attempt_key 为受信 Core
    生成的稳定键，≤128 字符）；
  - `classification ∈ {code, infrastructure}`、`classified_by = 'core'`（DDL CHECK
    拒绝任何其他主体——客户端/模型不能自报基础设施错误）；
  - 同项目复合外键链：`(project_id,batch_id)→execution_batches`、
    `(project_id,batch_id,run_id)→runs`、`(project_id,task_id)→tasks`，全部
    `ON DELETE RESTRICT`；`reason` 为重分类审计理由（初始 NULL）。
- 不建完整 `attempts` 表（`UNIQUE(task_id,number)`、owner/lease/进程字段属
  P03-4 真实 Attempt 生命周期）、不建 `workspace_leases`/`sessions`/通知表、
  `state_events` 不加 attempt 关联列。

## 2. 事务原语（受信 Core 内部面；不经命令路由暴露）

全部为同会话同步写事务原语（`assertInTransaction`，与 F-005 原语同一组合面；
已接线 `CommandTransaction.reserveTaskAttempt / reclassifyTaskAttemptAsInfrastructure /
getTaskAttemptReservation / getTaskExecutionCounters / getExecutionRun`）：

### 2.1 `reserveTaskAttempt`（总 Attempt 预占）

判定与写入顺序（任一步失败零写入）：

1. **输入校验**（ports `validateTaskAttemptReservationInput`）：`projectId/batchId/
   runId/taskId/attemptKey/maxAttemptsPerTask`（可选 1..100 或 null）；
   `classification`/`owner`/`lease` 等执行域字段是未知键（分类只能走重分类原语）。
2. **归属核验**（同事务绑定参数查询；复合外键兜底）：Batch/Run/Task 缺失
   `not_found`；跨项目或 Run 不属于声明的 Batch、Task 不在 Batch 单 Feature 范围
   `ownership`。
3. **幂等身份去重先于控制状态与额度**：同 `(project,task,attemptKey)` 且同
   Batch/Run 重放返回既有记录（不重复调账）；跨 Batch/Run 复用同身份
   `conflict attempt_key_reused`。
4. **有效控制状态**（活动集与迁移 v9 条件唯一索引同源，`paused/interrupted`
   不是可绕过的终态）：终态 Batch `conflict batch_not_active`、终态 Run
   `conflict run_not_active`。
5. **额度判定（全部先于任何写入）**，任一命中即 `conflict budget_exhausted`
   （details.reasons 携带 layer/dimension/limit/used）：
   - Batch 层：`attempts_created >= budget_snapshot.batch.maxTotalAttempts`
     （dimension `maxTotalAttempts`）；`now >= deadlineUtcMs`（dimension
     `deadlineUtcMs`，恰好到达即耗尽；当前批准预算快照为权威）；
   - Run 层（复用 `evaluateRunBudgetReservation`）：`attempts_created >=
     max_attempts_per_run`（dimension `maxAttemptsPerRun`）；已启动且
     `now - started_at >= run_time_limit_ms`（dimension `runTimeLimitMs`；未启动
     时时间维度未知不判耗尽）；
   - Task 层：`code_attempts_used >= effectiveMaxCodeAttempts`（dimension
     `maxCodeAttempts`；`resolveTaskAttemptCaps` 以 Task 副本 `execution_config.
     maxCodeAttempts` 为权威、缺省含首次共三次，`maxAttemptsPerTask` 由受信 Core
     事务外自有效配置解析后传入，两者同时生效按 min 绑定）；配置了总上限且
     `attempt_counter >= maxAttemptsPerTask`（dimension `maxAttemptsPerTask`）。
6. **同事务原子写入**：`execution_batches.attempts_created+1`（条件 UPDATE 仅
   活动态命中）与 `runs.attempts_created+1`（同上）与
   `tasks.attempt_counter+1, code_attempts_used+1` 与账本行插入（classification
   恒 `code`、classified_by 恒 `core`）一次调用全部生效。**不允许先提交扣额再
   另事务创建 Attempt**：调用方在同一 BEGIN IMMEDIATE 内组合后续写入（如 P03-4
   的真实 Attempt 行创建），任何后续失败整组回滚（组合事务测试覆盖）。

### 2.2 `reclassifyTaskAttemptAsInfrastructure`（受信基础设施重分类）

- 单向 `code → infrastructure`：账本行分类与审计理由持久、
  `tasks.code_attempts_used-1`（条件 `>= 1`，账本与计数不一致时 corrupt
  fail-closed）；**不触碰** `attempt_counter`、Batch/Run 累计计数、
  `runtime_starts` 与绝对 deadline（总 Attempt、已预占 Runtime 启动及绝对时间
  不退还）。
- **重复分类不重复调账**：已是 `infrastructure` 时幂等返回当前记录，零写入。
- 归属负例：Task 缺失 `not_found`、跨项目 `ownership`、账本缺失 `not_found`；
  理由为必填非空（≤512 字符，审计）。
- 分类主体为受信 Core 定值（`TASK_ATTEMPT_CLASSIFIED_BY_CORE = 'core'`），输入
  不含主体字段；命令面/能力面（`COMMAND_OPERATIONS`/`APP_CAPABILITIES`）不含
  任何 attempt/reserve/reclassify 操作——客户端或模型没有自报入口。

### 2.3 读取原语

`getTaskAttemptReservation`（同项目同 Task 同身份，无则 null）、
`getTaskExecutionCounters`（双计数持久读取；缺失 `not_found`、跨项目
`ownership`）、`getExecutionRun`（Run 记录含累计计数与冻结快照）。剩余额度 =
caps 与持久计数合并计算（`resolveTaskAttemptCaps` + 计数），不由内存快照回答。

## 3. 持久性不变量（测试断言事实）

- 取消、失败、数据库重开、同 Batch 新 Run、Task 换模型（策略 CAS 整体替换
  execution_config）**不清计数**；Batch/Run 历史输入/范围/配置快照逐字节不变。
- 成功代码尝试不退次数：预占后无任何退额路径（唯一减法是受信基础设施重分类）。
- 拒绝（budget_exhausted/conflict/not_found/ownership）路径零写入，计数不溢出
  （保持在上限值；DDL 非负 CHECK 兜底）。
- 重放幂等：同身份重放返回同一记录 ID，不重复调账。

## 4. 范围边界（本 Feature 不实现）

- 不实现 Task 拓扑选择、完整 Attempt 生命周期、owner/fencing、lease 或进程执行
  ——P03-4 在同一事务接入真实 Attempt 创建（以本账本行为同事务预算预占依据），
  不能用空接口或独立提前扣额替代本契约。
- Runtime 启动预占（F-007）、Run 结果结算与无进展计数（F-008）、预算修订命令
  （F-009）、只读查询面（F-010）分别由后续任务建设；本任务不新增命令操作、
  事件类型或回执形态。
