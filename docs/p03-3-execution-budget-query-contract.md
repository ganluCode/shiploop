# P03-3 / F-010 执行预算只读查询契约

P03-6装配执行服务后，阻塞原因新增`runtime_not_found`：生产未注册适配器时零外部启动，
不能把Run已接受或queued当成正在执行。`scheduler_not_assembled`仍保留用于尚未装配调度器的路径。

实施契约：`packages/core/src/ports/execution-budget-query.ts`（公开形状、冻结
词汇与 `buildExecutionBudgetStatus` 纯投影）、
`packages/core/src/adapters/sqlite/execution-store.ts`（只读查询面
`readExecutionBudgetView` / `findExecutionBatchRecord` /
`listBatchBudgetRevisionRecords`，单一 DEFERRED 一致读视图）、
`packages/core/src/application/query-service.ts`（`execution.budget.get` /
`execution.budget.revisions` 授权查询用例）与
`packages/core/src/adapters/sqlite/query-store.ts` 查询门面接线。
设计依据：core-design/04 §6.1（累计预算/剩余额度可查询、绝对 deadline 持久、
用量未知保留未知）与 core-design/08 §2（getBatch 只读展示；查询绝不扣预算）；
F-009 契约 §6「查询面（F-010：Batch/修订历史读取查询）」接续。本 Feature 不新增迁移
（v9..v13 既有表承担；历史 v1..v13 SQL/checksum 不变）。

## 1. 查询面（只读授权通道）

两个查询操作（`PublicError.operation` 与后续 Host 路由共用；Host/CLI 接线属
F-011/F-012）：

| 操作 | 输入（严格未知键拒绝） | 输出 |
|---|---|---|
| `execution.budget.get` | `{ projectId, batchId }` | `ExecutionBudgetStatusResult`（scope `execution-budget`） |
| `execution.budget.revisions` | `{ projectId, batchId, limit?, cursor? }` | `BudgetRevisionListResult`（scope `budget-revision-list`） |

- 能力位复用 `project.read`（只读查询；与 `execution.budget.revise` 的写能力
  分离——读预算不蕴含修订预算）；能力缺失先行 `forbidden`，不读任何行。
- 项目可见性把关（`requireProjectVisible`）先于读取：不可见项目与不存在项目
  对调用方同一 `forbidden`（不泄漏存在性）。
- **跨项目/不存在目标统一 `not_found`**（details 恒
  `{reason:'execution_entity_not_found', entityType:'execution_batch'}`）：
  `batchId` 属于其他项目与 `batchId` 不存在返回逐字段相同的错误，绝不区分
  存在性、不回显归属。
- 非法输入（非法稳定 ID、未知键、非法分页）在任何 SQL 之前
  `invalid_input` 拒绝。

## 2. 一致读视图（零写入、零事件、零唤醒）

`ExecutionBudgetQueryReadStore` 是纯读取窄端口（无任何写原语）；适配器以
**单一 BEGIN DEFERRED 读事务**一次取得 Batch 行 + 全部 Run 行 + 固定范围内
Task 计数/策略副本 + 全局/项目当前配置（总 Attempt 上限解析用）——并发修订/
结算只能观察到完整前后状态，不出现混合视图。查询不扣预算、不写
`state_events`、不创建任何行、不调用调度器/唤醒端口（持久计数、事件计数与
账本行数在查询前后逐字节一致，测试断言）。

## 3. 公开形状与已知/未知字段纪律

- **固定 Feature 范围**：`batch.featureIds` 取自不可变 `scope_snapshot`
  （恰一成员且等于 `batch.featureId`，漂移即 `corrupt` fail-closed）。
- **各层上限**：Batch 层当前预算快照（`budget`，schemaVersion=1 完整快照）+
  Run 层派发时冻结上限（`runs[].limits`）+ Task 层 `caps`
  （`resolveTaskAttemptCaps`：策略副本 `maxCodeAttempts` 缺省含首次共三次；
  总 Attempt 上限来自同一读视图的有效配置段合并，未配置 = null）。
- **已用/剩余额度**：计数维度（`maxRuns`/`maxTotalAttempts`/
  `maxRuntimeStarts`/`maxNoProgressRuns`）恒已知；`deadlineUtcMs` 维度
  `used` = 查询参考时间、`remaining` = 剩余毫秒（绝对 deadline 持久，暂停
  不自动延长）；资源维度（`maxTokenTotal`/`maxCostTotal`）**用量未知时
  used/remaining/exhausted 为 null 并列入 `unconfirmedDimensions`，绝不填零**；
  未配置资源上限不产生该维度（不虚构 0 限额）。
- **启动预占与实际用量分开**：`runtimeStartsReserved`（F-007 预占计数）与
  `usage`（`tokenUsed`/`costUsed` 已知实际用量）分列；当前结算账本无用量列
  （F-008 边界），实际用量恒 null（未知）。
- **未启动/无耗时/无退出信息保持 null**：`runs[].startedAt`/`endedAt`/
  `elapsedMs`、`tasks[].firstPassedAt` 未发生即 null，不以 0 冒充；已结束 Run
  的耗时以 `ended_at` 冻结，不随查询时间漂移。
- **accepted/queued 不显示为验收成功**：Run/Task 状态原样输出（`queued` 就是
  `queued`）；`passed`/`firstPassedAt` 只反映受信领域事实（受信 Verifier
  写入），查询不推导任何「成功」汇总。

## 4. 阻塞原因（冻结词汇）

`blockingReasons` 为结构化条目 `{layer, layerId, reason, dimension?, limit?,
used?}`，reason 冻结为 `EXECUTION_BUDGET_BLOCK_REASONS`：
`counter_exhausted` / `deadline_reached` / `resource_exhausted` /
`code_attempts_exhausted` / `budget_exhausted` / `scheduler_not_assembled`。

聚合顺序与来源（只读推导，绝不产生写入）：

1. Batch 预算判定（`evaluateBatchBudgetReservation`，与 budget_exhausted
   冲突词汇同源的 dimension/limit/used 定位）+ 持久控制原因（无进展耗尽的
   `budget_exhausted`）；
2. 非终态 Run 预算判定（`evaluateRunBudgetReservation`）+ 未启动 Run 的持久
   not-ready 原因（`scheduler_not_assembled`）；
3. Task 尝试上限（`maxCodeAttempts` 耗尽 → `code_attempts_exhausted`；
   总 Attempt 达 `maxAttemptsPerTask` → `counter_exhausted`）。

## 5. 预算修订历史分页（复用既有有界分页规则）

- 复用计划分页同一套：`limit` 默认 50 / 上限 200（1..200 整数，越界/非整数/
  未知键 `invalid_input`）；游标沿用 `plcur_v1_` 受控游标（绑定数据根身份 +
  项目 + Batch；`PlanListScope` 增 `'budget-revisions'` 层级，既有层级指纹
  公式不变）。
- 游标解析先于任何读取：跨批次/跨项目/跨根重放或损坏游标一律
  `invalid_input(invalid_cursor)`，绝不当作从零读取、也不先泄漏目标存在性。
- 记录按修订版本升序键集分页（`UNIQUE(batch_id, version)`；初始
  `version=1` 与历史版本逐行留存），`nextCursor` 绑定同一 Batch；记录公开
  形状含 version/budget/deadlineAtUtcMs/approvedBy/reason/createdAt
  （审计可核对批准主体、时间、理由及前后值）。

## 6. 脱敏边界

输出只含身份/计数/上限/时间等结构化事实：**绝不携带** `scope_snapshot`/
`config_snapshot`/`input_snapshot` 正文、秘密配置、任意文件内容或开发机
绝对路径（测试对沙箱根、数据根、仓库目录、制品正文与路径形态逐项断言）。
修订 `reason`/`approvedBy` 是审计契约字段（有界用户文本/受信主体），不是快照
正文。

## 7. 范围边界（本 Feature 不实现）

Host 路由/HostClient 方法与 CLI 子命令（F-011/F-012 已落地：HostClient
`getExecutionBudgetStatus`/`listBatchBudgetRevisions` 与 `shiploop execution budget`，
见 `docs/p03-3-cli-execution-operations.md`）、跨进程竞争与故障边界
（F-013）、集成验收（F-014）；暂停/取消/恢复命令、token/cost 实际用量结算、
Scheduler/Runner 装配仍属后续任务（查询如实呈现 queued/
`scheduler_not_assembled`，不虚构执行能力）。本契约只覆盖 Core 查询面。

## 8. 验证记录（F-010）

- 新增：`test/modules/execution/budget/p03-3-execution-budget-query.test.ts`（10 用例：一致读视图全字段
  与重开一致、未知字段 null 不填零/启动预占与实际用量分开/queued 不冒充成功、
  预算耗尽与 deadline 恰好到达结构化阻塞、正常剩余、修订后剩余与旧 Run 冻结
  快照、修订分页与游标续读、非法分页/跨批次游标/跨项目折叠 not_found 不泄漏
  存在性、查询零写入零事件、授权与非法输入矩阵、输出脱敏断言）、
  `test/modules/execution/budget/docs-p03-3-execution-budget-query-contract.test.ts`（本文档守护）。
- 受影响回归：计划查询/分页游标（p03-1-plan-queries、authorized-queries）、
  执行域存储与预占/结算/修订（p03-3-*）、查询装配（core-assembly）等由
  verification 清单选中执行。
