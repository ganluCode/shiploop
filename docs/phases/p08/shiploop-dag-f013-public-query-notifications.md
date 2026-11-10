# DAG F-013：公共查询展示上下文、结构化错误与通知接线

本 Task 落地 input/2026-11-09-dag-integration-lifecycle.md FR-09：DAG 基线、集成身份、
合并顺序、证据与阻塞原因在公共查询中可追踪且不泄露敏感信息。不新增第二套协议；
沿用既有 Host/CLI 单一线协议、locale 纪律与通知机制。

## 查询展示上下文（稳定层级编码/名称/branchName）

新端口 `ports/delivery-display-context.ts` + SQLite 装配
`adapters/sqlite/delivery-display-context-store.ts`：从 `entity_display_codes`
（创建期固化的 display-only 别名，tombstone 保留）+ features/phases 持久行投影
`PublicDeliveryEntityDisplay`（featureId、displayCode、title、branchName、phaseId、
phaseDisplayCode、phaseTitle）。编码缺失保持 null，不以 UUID 片段冒充；批量读取
有界（≤128）；不携带路径/凭据/模型正文。生产 `composition.ts` 经
`createQueryService({ deliveryDisplayReads: queryStore })` 装配；未装配时相关查询
保持既有字段（明确缺省，不虚构编码），不存在静默降级为错误数据。

五个查询面同时可见的交付事实：

| 查询 | 新增字段 |
| --- | --- |
| `features.delivery.get` | `feature.title/branchName/phaseId/phaseTitle/displayCode/phaseDisplayCode` + 顶层 `dag`：`frozenBaseCommit`（受管编码工作区 base_commit；无行保持 null）、`predecessors[]`（displayCode/title/commitSha/evidence*，来自后继权威集成计划的 predecessor 快照）、`integrations[]`（integrationId/status/inputDigest/targetBaseline/mergeOrder/commitSha/evidenceId）、`successors[]`（displayCode/title/integrationId/status/blockReasons，即后继阻塞原因） |
| `integration.plan.get` | 可选 `display`：`successor`（完整展示上下文）与 `predecessors[]`（displayCode/title）；由查询服务一次有界批量读取装配 |
| `git.operations.list/get` | 可选 `featureDisplay`（目标 Feature 展示上下文）；列表按去重 featureId 批量读取 |
| `git.repairs.list/get` | 同上 `featureDisplay` |
| `phases.graph.get` | `phase.displayCode` 与 `features[].displayCode`（plan-store 同事务读取编码映射；未投影时缺省） |

SQLite 侧 `readFeatureDeliveryView` 在同一一致读事务内组装 dag 字段（features/phases/
entity_display_codes/feature_dependencies/integration_plans/integration_predecessor_snapshots/
managed_workspaces 单事务连接）；持久 JSON/身份损坏 fail-closed（corrupt）。

## 线协议同步

- `app-wire.ts`：新展示字段/dag/display 均进入冻结字段集（exactKeys）；新增
  `validateDeliveryEntityDisplayWire`（编码形状 `^[A-Z][A-Z0-9-]{0,63}$`、标题/branchName
  界内、branchName 拒绝前导 `/` 与控制字符）。展示字段为可选：未装配时缺省不阻塞查询。
- `protocol.ts` 导出 `PublicDeliveryEntityDisplay`、`FeatureDeliveryDagView`、
  `IntegrationPlanDisplayView` 与端口校验函数；HostClient/CLI 直接复用，不建第二套词汇。
- CLI（`app/delivery.ts`）：feature delivery 人类行输出 display 行与 dag 三段
  （predecessor/integration/successor，含 blockReasons）；integration plan 输出后继
  展示与前置编码标签；git operation/repair 输出 featureDisplay 行。同时修复四个
  formatter 使用字面 `\\n`（输出单行带反杠）的历史缺陷，改为真实换行。help 文本
  同步 feature delivery 的展示边界。

## 结构化错误

查询面错误语义保持既有 PublicError 纪律：code/reason/commandId 与对象身份、
revision/digest 上下文由 `mapToPublicError` 保留；本 Task 新增校验失败均携带
定位字段（invalid_display_code/invalid_branch_name 等），不返回裸 conflict。
wire 拒绝越权字段（绝对路径/凭据形状）时以 `response_malformed` + 定位 reason
失败，不回显原始内容。

## 集成/修复通知（事件开关与去重）

新增冻结事件类型（`ports/events.ts`，同源写入 SQLite `state_events`）：

- `integration.plan.updated`（aggregate `integration_plan`）：payload
  `{schemaVersion, integrationId, successorFeatureId, status, blockReasons, staleReasons}`。
  由 `integration-plan-store.ts` 在真实转换边界同事务写入：create（pending/
  dependency_passed 或创建期 blocked）、updateResult（integration_passed 等）、
  updateStatus（状态变化）。同状态幂等重放早退，不产生新事件。
- `git.repair.updated`（aggregate `git_repair`）：payload
  `{schemaVersion, repairId, featureId, status, reason}`，status ∈
  `requested|blocked|attempt_modified|attempt_no_change|attempt_failed|attempt_cancelled`。
  由 `git-agent-repair-store.ts` 写入：首次 authorize（requested 或创建期 blocked）、
  首次 hold（blocked，保留首个 hold 不被后续结果覆盖）、attempt settle（获准修复
  结果）。幂等重放与重复 hold 不重复发事件。

两类型进入 `NOTIFICATION_SUBSCRIPTION_EVENT_TYPES`；`deriveNotificationSummary`
派生 `integration_status` / `git_repair_status` 脱敏摘要（冻结身份+受控状态/原因，
无路径/凭据/payload 原文）。投递去重沿用既有 `(event_id, channel_id)` 唯一约束：
同一事件重复扫描只保留一条 delivery。事件 payload 经 mapStateEvent 白名单校验
（未知键 fail-closed）。

## Prompt/模板边界

GitAgent Prompt 继续使用 `packages/core/prompts/{en-US,zh-CN}/repair/git-agent.md`
既有中英文模板（F-010 接线），本 Task 不新增嵌入代码的 Prompt、不新增配置项；
locale 纪律与凭据脱敏不变。

## 本地验证与边界

- 单元：`test/modules/delivery/p08-dag-f013-public-query-views.test.ts`（9 项）覆盖
  五个查询面的投影/wire/CLI 格式化/脱敏拒绝与通知订阅/摘要。
- SQLite（真实临时库）：`test/modules/storage/sqlite/p08-dag-f013-delivery-context.test.ts`
  （6 项）覆盖展示上下文读取与批量界、dag 一致读投影（真实触发器生成的 P01-Fxx 编码）、
  phase graph 编码、集成事件幂等边界与通知投影去重、修复事件 authorize/hold 边界。
- 同步受影响契约测试：events-contract、notification-projection、p03-8-f011 CLI 夹具、
  `test/helpers/current-schema.ts`（F-012 追加 v71 后未同步的既有遗漏，本 Task 补齐）。
- `tsc --noEmit` 与 `check:boundaries` 通过。

未执行：真实 Host/CLI 跨层冒烟、全仓回归、Phase 验收、live/真实模型（由 Nezha
独立验证与 Phase 集成验收覆盖；本 Task 的 CLI 视图测试不能替代真实 Git/SQLite/Host/
进程纵向）。基线既有失败（host-lifecycle-contract 两项，含 production-command-tools.ts
静态隔离断言）在受测 HEAD 上复现一致，非本 Task 改动引入，未修改。
