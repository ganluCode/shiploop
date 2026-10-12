# P03-3 显式执行启动契约（F-005：ExecutionController 启动、同 Batch 后续 Run、原子提交范围、runsCreated、Run、回执与事件）

状态：已实现（F-005 范围：显式启动命令与同父 Batch 重试派发、原子提交、runsCreated
计数、Run 快照、回执与脱敏事件、提交后唤醒窄端口与 queued 可查询原因；预算预占与
Attempt 记账随 F-006/F-007、结算随 F-008、预算修订随 F-009、查询面随 F-010、
HostClient/CLI 入口随 F-011/F-012）。
权威实现：`packages/core/src/ports/execution-start.ts`（操作常量、workKey 纯函数、
唤醒窄端口、准备/提交端口形态与拒绝词汇）、`packages/core/src/application/execution-start.ts`
（事务外准备 + 短写事务内提交编排与提交后唤醒边界）、`packages/core/src/ports/execution-store.ts`
与 `packages/core/src/adapters/sqlite/execution-store.ts`（迁移 v9 三表事务原语与
`execution.run.dispatched` 事件）、`packages/core/src/ports/commands.ts` +
`application/command-service.ts`（`execution.start` 命令面接线与提交后唤醒）、
`packages/core/src/adapters/composition.ts`（组合根装配与 `CoreApplication.executionStart`）、
`packages/host/src/contract/lifecycle.ts`（Host 通用命令路由接线宣告，v5 内增量）。
守护测试：`test/p03-3-execution-start.test.ts`、`test/commands-contract.test.ts`、
`test/authorization-contract.test.ts`、`test/p03-3-work-command-receipts.test.ts`、
`test/docs-p03-3-execution-start-contract.test.ts`。

## 1. 命令面与授权

- 操作 `execution.start`（`COMMAND_OPERATIONS` 白名单第 20 项；project scope；创建类
  不携带 expectedRevision）；能力位 `execution.start`（与 `execution.preview` 共享
  同一授权面——baseline.preview/baseline.run 共享 baseline.run 的同一先例）。
- payload 两种互斥形态（严格未知键拒绝；batchId/runId/status/runsCreated 等服务端
  决定字段不能经请求输入）：
  - 新授权：`{ featureIds: string[], budget: object, previewDigest: string }`
    （`retryBatchId` 可显式 null）；空范围 `invalid_input/empty_scope`（启动必须携带
    明确目标，没有「空跑」语义）、多成员 `multi_feature_scope_unsupported`；
    `previewDigest` 必须 64hex（用户确认的 `execution.preview` 结果摘要）；
    budget 深校验在应用层复用 `ports/execution-budget` 权威校验器（参考时钟 deadline）。
  - 同父 Batch 显式重试：`{ featureIds: string[], retryBatchId: string }`——预算/
    预览摘要必须缺席（重试共享父预算；工作身份由 workKey 绑定；父 Batch 自身即
    同 Phase 活动位，新授权预览必然报 `active_batch_in_phase` blocked，重试不重算预览）。
- 幂等：同 commandId 完整重放返回原回执（同 Batch/Run），不再次扣额或唤醒；复用
  commandId 异参 `conflict/idempotency_key_reuse`（既有命令面机制）。端口未装配
  → `unsupported`（不冒充能力）。

## 2. 编排顺序（事务外有界输入核验 → 短写事务内重核 → 原子提交）

事务外准备（`prepareExecutionStart`；全部仓库/制品 I/O 在写事务之外）：
1. 预算深校验（纯；非法 `invalid_input/invalid_budget` 携带字段定位）；
2. 范围形态（纯）：空/多成员结构化拒绝；
3. 只读预览重算（复用 F-004 预览端口：一致读视图 + 受控仓库 I/O）：非 ready
   （no_work/blocked）或摘要与用户确认值不一致 → `not_startable`（事务内固化
   rejected `preview_stale`，零创建零扣额）；重试形态跳过（不重算预览）。

短写事务内提交（`submitExecutionStart`；同一 BEGIN IMMEDIATE 内全部重核与写入）：
1. 项目 active（缺失/不可见 forbidden；非 active → `preview_stale`）；
2. 计划快照 + 批准依据（P03-2 复合身份 = planDigest + 当前检查政策内容摘要；
   失效 → `preview_stale`）；
3. Phase open（否则 `preview_stale`）；待执行工作 pending/failed 非空（否则 `preview_stale`）；
4. 必需输入解析身份（同事务权威制品索引；缺失/未 ready/漂移 → `preview_stale`）；
5. 新授权专属：逐 Task 策略副本与权限面内容身份、`previewDigest` 以事务内权威视图
   + 事务外代码身份重算比对（任一实质变化 → `preview_stale`；纯标签/默认 modelMap
   不参与，与 F-004 同一纪律）；
6. 活动执行：同 Feature 活动 Run → 抛出 `conflict/execution_in_progress`（零回执，
   客户端可换 commandId 重试）；基线占用（同事务 `readBaselineOccupancy` 权威读，
   不被任何内存锁绕过或清空）→ `resource_busy/baseline_in_progress`；
7. 预算：新授权以提案判定（deadline 以事务时钟重核）；重试以父 Batch 冻结预算 +
   累计计数判定（`evaluateBatchBudgetReservation`）→ 不允许 → rejected
   `budget_exhausted`。

## 3. 首次明确授权（单 Feature Batch + Run）

- 同 Phase 活动 Batch 唯一（另一批次持有 → `conflict/execution_in_progress` 抛出）；
- 创建 Batch（`runsCreated=1`、初始 queued、`runtime_starts=0`、快照只含身份级内容：
  scopeSnapshot={schemaVersion:1, featureIds, previewDigest}、configSnapshot=批准复合
  身份+逐 Task 策略/权限摘要、budgetSnapshot=schemaVersion 1 预算契约）+ 初始预算
  修订行（version=1、approvedBy=可信主体、reason='initial_authorization'）+ Run
  （dispatchOrdinal=1、purpose='execute'、上限从预算契约冻结、scopeDigest=previewDigest、
  status='queued'）+ 脱敏 `execution.run.dispatched` 事件 + Work accepted v6 回执
  （operationId=batchId）——同一短写事务成功或全部回滚，返回真实 Batch/Run ID；
- Runtime 启动数恒为零：不启动任何 Runtime/Git/检查进程；accepted 不改变 Task
  passed 或 Feature completed（不写任何计划实体行）。

## 4. 同父 Batch 显式重试

- 终态 Batch（cancelled/succeeded/failed）→ rejected `batch_not_active`（授权关闭，
  新工作需新的明确授权）；范围不一致 → `retry_scope_mismatch`；
- workKey（`computeExecutionWorkKey`：Feature + 用途 + 有效计划摘要 + 必需输入解析
  身份；不含代码身份与预算）必须命中父 Batch 既有 Run：未命中（计划/输入实质
  变化）→ rejected `retry_work_key_absent`；已成功 → rejected `work_key_succeeded`
  （拒绝自动再派发）；
- dispatchOrdinal = 同 workKey 最大序号 + 1；`recordExecutionRunDispatch` 单语句
  条件 UPDATE 原子递增 `runs_created`（仅非终态 Batch 命中）；仍受父预算（计数/
  deadline 耗尽 → `budget_exhausted`）；成功、失败和取消 Run 均不退还 Run 次数
  （无任何递减路径；换 Run ID 或修改模型不清计数——Task 累计额度记账随 F-006）；
- 终态 Run 不重开：重试创建新 Run 行（新 runId、递增 ordinal），不提供任何 Run
  重开/不可变列覆盖原语（迁移 v9 触发器兜底）；
- 重试回执为 **completed v5**（同事务同步完成的派发结果）：结果
  `{schemaVersion:1, dispatched:true, batchId, runId, featureId, dispatchOrdinal,
  runsCreated, status:'queued', runtimeExecution:false}`（身份级事实，不重复占用
  授权身份——v10 迁移 `operation_id` 唯一索引使同 Batch accepted 至多一条，
  operationId=batchId 专属首次授权）；
- 新 Batch 只能来自不带 retryBatchId 的新命令（新的明确用户授权）；控制层不自动
  创建子批次、不扩大授权范围（单 Feature 范围由 DDL CHECK 与插入校验双重冻结）。

## 5. 拒绝/冲突词汇（冻结）

- rejected 回执（conflict）：`preview_stale` / `budget_exhausted` / `batch_not_active` /
  `retry_scope_mismatch` / `retry_work_key_absent` / `work_key_succeeded`；
- 抛出型（不落回执，客户端可换 commandId 重试）：`conflict`/`execution_in_progress`
  （同 Feature 活动 Run 或同 Phase 活动 Batch 争抢）、`resource_busy`/`baseline_in_progress`
  （基线在途/隔离占用）；
- 结构化拒绝（invalid_input，不落回执）：`empty_scope` / `multi_feature_scope_unsupported`
  / `invalid_budget` / payload 字段形态错误。

## 6. 唤醒与可查询排队原因

- 唤醒窄端口 `ExecutionDispatchSignalPort`：仅在写事务成功提交且非重放的新派发回执
  （首次 Work accepted v6 与重试 completed）后由命令服务 best-effort 调用；事务失败
  在提交前抛出，不触达唤醒；唤醒丢失/失败被吞掉（不重复创建 Run、不回滚已提交
  事务）——持久 queued Run 是权威，可从数据库核对；
- 无 Scheduler/Runtime 装配时：Run 保留 `queued` 且 `reason='scheduler_not_assembled'`
  （可查询排队原因，F-010 查询面读取）；装配唤醒端口时 reason=null；两种形态都
  不伪造完成、不提前启动进程（`runtime_starts` 恒 0，Runtime 启动额度预占属 F-007）；
- 事件 `execution.run.dispatched`：进入 `PUBLIC_STATE_EVENT_TYPES` 白名单，聚合
  `run`（`StateEventAggregateType` 扩展）、payload 恒 `{dispatched:true}`（不携带
  预算数值/计划正文/输入正文/启动语义），公开映射读取同一白名单校验。

## 7. 与既有冻结面的关系登记

- F-003 Work 回执契约更新：`execution.start` 进入 `COMMAND_OPERATIONS` 后，
  `authorizeCommandReplay` 对该操作的重放改为重新核验 `execution.start` 能力
  （F-003 预留的「命令能力未接线」拒绝路径随启动命令接线退役）；completed/
  rejected 工厂对 `execution.start` 合法（重试派发结果为 v5 completed），但携带
  Work 关联字段（batchId/runId）即拒绝（关联身份仅限 Work accepted v6）；v6
  accepted 的 operationId=batchId 与 `operation_id` 唯一索引共同保证同 Batch
  accepted 至多一条。
- F-004 预览契约：preview_stale 判定随本任务落地（预览不保证稍后仍可运行；启动
  事务重核全部前置条件与预览身份）。
- Host 通用命令路由接线宣告（`APPLICATION_COMMAND_CAPABILITIES`）随 Core 白名单
  同步 +1（v5 内增量，升版随 F-011 接线任务评估）；HostClient/CLI 入口属后续任务。
- 能力位不新增（`execution.start` 自 F-004 已冻结，19 项不变）；命令操作白名单
  19 → 20。

## 8. 验证记录（F-005，attempt 1）

- `test/p03-3-execution-start.test.ts`（20 用例，真实临时 Git/SQLite/制品）：
  首次授权原子提交（runsCreated=1/runtime_starts=0/queued+可查询原因/初始修订行/
  脱敏事件/白名单与公开映射/Task-Feature 不变）、注入失败整组回滚、preview_stale
  矩阵（摘要不一致/代码漂移/实质修订重批/预算调整/活动 Run 阻塞/端口未装配）、
  payload 结构化拒绝矩阵、事务内基线占用与活动 Run 争抢（afterPrepare 竞态窗口
  注入，零回执零写入）、幂等重放（同 Batch/Run、不扣额不唤醒）与 commandId 复用
  conflict、同父 Batch 重试（ordinal 递增/runsCreated=2/预算修订行不新增/workKey
  跨代码进展稳定/重试 completed 回执与重放/重试形态携带预算拒绝/已成功 workKey/
  终态 Batch/计划修订 workKey 变化/maxRuns=1 耗尽）、提交后唤醒（无装配不唤醒、
  失败吞掉持久可核对、事务失败不唤醒、纯边界 completed/rejected/重放不唤醒）。
- 受影响回归：commands-contract（白名单 20 项+specs）、authorization-contract
  （矩阵+重放授权）、host-lifecycle-contract/host-app-routes/p02-3-init-overview-
  vertical（接线宣告同步）、p03-3-work-command-receipts（工厂 Work 关联边界）、
  p03-3-execution-preview、sqlite-schema-migrations 等；全量与边界检查见
  progress.md 与 tool-logs。
