# P03-9 / F-013 控制进度、恢复诊断与 finalization 收尾结果查询契约

日期：2026-10-19。状态：已实现 Core 查询面与 Host GET 路由接线；HostClient/CLI
专用入口仍由 F-014/F-015 接入（与 P03-9 F-001/F-008 命令面同一边界）。

## 1. 目标与边界

按既有查询与 Artifact 读取模式暴露三组只读事实；不新增业务事实源、不新增
迁移、不产生任何执行/计数/事件副作用：

- `execution.run.control.get`（GET `/v1/runs/:runId/control?projectId=`）：
  Run 控制进度——持久状态与原因（`pausing/cancelling/paused/interrupted`
  等原样）、`pauseRequestedAt`、父 Batch 简报、关联 Attempt（未知退出/耗时/
  用量保持 null）、关联停止 operation（`evidenceRef`/`stopConfirmed`/
  `forced` 未知保持 null）、未释放租约（held/quarantined）与从持久事实
  派生的显式后续动作；
- `execution.batch.control.get`（GET `/v1/batches/:batchId/control?projectId=`）：
  同一语义的 Batch 视图（子 Run/Attempt 有界扫描，超限置 truncated）；
- `execution.run.recovery.get`（GET `/v1/runs/:runId/recovery?projectId=`）：
  finalization-only Run 的受限收尾 scope（来源 `historicalRunId`、缺失
  步骤、`runtimeStarts=0`/`newAttempts=0` 零编码承诺）、Attempt 的 F-007
  续接记录（请求模式 `requested.mode` vs 实际决策 `decided.mode`、来源
  Attempt/Session 引用、handoff）、父 Batch 累计预算与计数（用量未知恒
  null，与 `execution.budget.get` 同语义），以及复用 P03-8 F-010 公共形状
  的 Task/最终检查/审批/提交分轴事实（同一 `FeatureDeliveryView` 重建）。

查询一律不以日志、Runtime 声明或事件流推断完成；历史 Attempt/Run 全部可
追溯；重复查询不产生执行、计数或副作用（一致读视图，零写入零事件）。

## 2. 实现落点

- 契约：`packages/core/src/ports/execution-control-query.ts`（操作身份、
  `EXECUTION_CONTROL_NEXT_ACTIONS` 冻结词汇、读视图、`validateRunFinalizationScope`
  与纯投影/派生函数）；
- 适配器：`packages/core/src/adapters/sqlite/execution-control-query-store.ts`
  （BEGIN DEFERRED 一致读；Attempt 行复用既有 `attemptFromRow` 校验——含
  F-007 recovery 记录校验；分轴事实复用 `FeatureDeliveryQueryReadStore`）；
- 门面/装配：`SqliteQueryStore.executionControlReads`、
  `createQueryService({ executionControlReads })`、composition 注入；
- Host：`APPLICATION_QUERY_CAPABILITIES`/`APP_OPERATIONS` 追加三个操作；
  路由后缀 `RUN_CONTROL_ROUTE_SUFFIX`/`RUN_RECOVERY_ROUTE_SUFFIX` 与
  batches `control` 子资源；`app-transport` 只做形态转换，授权/可见性/
  身份校验由 Core 单一权威复核。

## 3. 授权与脱敏纪律

- 能力位复用 `project.read`；跨项目/不存在目标统一 `not_found`（不泄漏
  存在性）；非法身份在任何读取之前 `invalid_input`；不可见项目 `forbidden`；
- 停止/隔离证据只暴露受控 Artifact 引用（`evidenceRef`/`diagnosticRef`），
  正文经既有 ArtifactVerifier/受控 locator 通道读取；查询响应不含绝对
  路径、快照正文或凭据；租约 `resourceKey` 是规范化哈希键；
- 列表有界：attempts ≤200、runs ≤50、stopOperations ≤50、continuations
  ≤200（上限+1 扫描检测截断，置 `truncated`/`attemptsScanned`）；
- finalization scope 损坏 fail-closed（`corrupt_state`），不折算普通 Run。

## 4. 显式后续动作（冻结词汇，从持久事实派生）

`none / resume / resume_blocked_occupancy / await_attempt_settlement /
await_stop_settlement / stop_reconcile / retry_final`：

- 停止 operation `stopping` 或目标 `cancelling` → `await_stop_settlement`；
- 存在 `uncertain` operation → `stop_reconcile`（先核对停止证据）；
- `pausing` → `await_attempt_settlement`；
- `paused`（或 Batch 内有 paused Run）且无活动 Attempt/held/quarantined
  租约 → `resume`，否则 `resume_blocked_occupancy`；
- `failed` 且持久 `input_snapshot.finalization` 有效 → `retry_final`；
- 集合为空时为 `['none']`。动作只是显式命令/人工入口提示，绝不暗示自动
  执行；`interrupted` 的恢复由 F-005/F-006 启动恢复门控决定，不在动作内
  承诺。

## 5. 聚焦验证

`test/modules/recovery/p03-9-f013-control-recovery-query.test.ts`（真实临时 SQLite + 真实
Host 纵向，零模型）：

- paused/pausing/cancelling（uncertain 停止 + interrupted Attempt +
  quarantined 租约）与 Batch 控制查询的状态/原因/证据/动作映射；
- 未知用量/耗时/退出码保持 null（不以 0 冒充）、`forced=null` 不以 false
  冒充、uncertain 停止无 `settledAt` 但有 `checkedAt`；
- finalization-only Run：来源、缺失步骤、零编码承诺、累计预算与分轴事实；
  普通 Run 不冒充存在；F-007 续接记录请求/实际模式展示；损坏 scope
  fail-closed；
- 授权：restricted `forbidden`、未知/跨项目统一 `not_found`、非法身份
  `invalid_input`、重复查询快照逐字节一致；
- Host：GET 路由 200/401/400/404 与未匹配形态 `unknown_operation`；
  操作清单与能力宣告同步。

既有查询装配测试同步 `executionControlReads` 注入；Host 能力清单测试同步
三个新查询与 F-008/F-010 遗留的 `execution.resume`/`execution.retryFinal`
命令宣告。Feature 全量门禁由 Nezha 独立执行。
