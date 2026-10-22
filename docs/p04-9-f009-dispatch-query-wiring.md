# P04-9 F-009：派发队列与执行槽位接线 Host / HostClient / CLI

日期：2026-10-22。范围：把 F-008 的 Core 只读投影接到既有认证 Host、HostClient 与 CLI；
没有新表、迁移、预算/队列写入口或第二套控制平面。

## 查询契约

- 新操作 `execution.dispatch.list`（`EXECUTION_DISPATCH_LIST_OPERATION`），
  `GET /v1/dispatch-queue?projectId=&limit?=&cursor?=`（`DISPATCH_QUEUE_ROUTE`）。
- 能力位复用 `project.read`；Host 把它加入 `APP_OPERATIONS`、
  `APPLICATION_QUERY_CAPABILITIES` 与 `AppQueryOperation`，握手真实宣告（46 → 49 项：
  P04-5 的两项 recording 查询此前漏登记，本次与 F-009 一并同步）。
- 查询参数白名单只含 `projectId/limit/cursor`；`capacity/owner/version/release/slotId/
  state` 等键一律 400 unknown_query_parameter。集合根只允许 GET（POST → 405），
  无子资源（`/v1/dispatch-queue/...` → 404 unknown_operation）。容量 >1 仍由 Core 装配
  期拒绝，新增入口不提供任何容量/归属设置。
- `HostClient.listExecutionDispatchQueue(projectId, {limit?,cursor?})` 复用计划分页与
  `plcur_v1_` 受控游标；读取后核对记录归属，跨项目响应按 `response_malformed`
  拒绝。

## 响应解码

- `validateDispatchQueueListResultWire` 精确键集校验：schemaVersion 不符 →
  `unsupported_schema_version`，scope 必须为 `dispatch-queue`，槽位摘要计数非负、
  capacity ≥1、`otherProjectActive` 必须为布尔（不接受对象夹带项目身份）。
- 记录复用 Core 冻结词汇：`DISPATCH_DISPLAY_STATES`、`DISPATCH_BLOCKING_REASONS`、
  `RUN_DISPATCH_CLAIM_ORIGINS/STATES`、Attempt 状态/阶段；未知时间保持 null，
  Attempt 摘要不允许快照正文等未知键。
- 为让 Host 复用单一来源，Core 增加了上述两个冻结数组导出（值与原 type union 相同）。

## CLI

- 新子命令 `execution dispatch --project <id> [--limit] [--cursor] [--json]`；
  无位置参数，不接受 `--owner/--version/--capacity/--release/--state`。
- `buildExecutionDispatchView` 原样保留槽位摘要与认领/槽位/Attempt 事实，并派生
  `waitCategory`（none/slot/isolation/control）与受控中文 `blockingExplanation`；
  completion 恒为 `featureVerified:false`/`delivered:false`，说明 Runtime 正常返回、
  Attempt succeeded 或已占槽都不代表验证通过或交付成功。
- 文本输出展示 `slots capacity/active/available/quarantined/projectActive/
  otherProjectActive`、每条 Run 的 state/blocking、claim/slot/attempt 与原因说明，
  未知值显示 `none`，不打印路径或凭据。
- 帮助新增 `execution.dispatch` 作用域并在 `execution` 用法中列出。

## 验证证据（本地定向）

日志与真实退出码位于 Feature workspace `verifications/F-009/runtime-logs/`。

| 检查 | 结果 |
| --- | --- |
| 新增 CLI 纯面层（参数/拒绝写参数/视图/文本/帮助） | 8 passed，exit 0（`test-wzn71snl.log`） |
| 新增真实 Host + HostClient 纵向（投影同源、摘要、分页、401/400/404/405、跨项目摘要、解码器） | 23 passed，exit 0（`test-bkekzttk.log`） |
| 新增有界构建 CLI（`tsc -b` + `prepare-cli-bin`，临时 Host） | 4 passed，exit 0（`test-f1chdfny.log`） |
| 既有 Host 路由/能力与 onboarding 握手回归 | 119 passed，另 1 失败为既有 stop.manual 漂移（见下） |
| 既有调度 Host 接线 + CLI 参数回归 | 46 passed，exit 0（`test-68dj14li.log`） |
| 既有 F-008 投影 + 派发槽位契约 | 16 passed，exit 0（`test-mx46kvcx.log`） |
| `npx tsc -p tsconfig.json` | exit 0 |

## 未运行与既有缺口

- `test/modules/host/host-lifecycle-contract.test.ts` 仍有 1 项失败：Core
  `COMMAND_OPERATIONS` 已由 P04-7（`8f252ad`）加入 `execution.stop.manual`，但 Host
  `APPLICATION_COMMAND_CAPABILITIES` 未同步宣告。该漂移早于本任务，且属命令面，
  未在 F-009 中改动。本次已把该测试的 queries 预期补上 P04-5 recording 两项与本次
  dispatch 一项；失败只剩上述命令漂移（`test-5x59cj0r.log`）。该文件不进入 F-009 索引。
- 未运行全量、Feature/Phase/P04 验收、`npm run verify`、live 或真实模型；不声称阶段放行。

仓库索引：`test/index/phases/P04/features/P04-9/tasks/F-009.json`（9 文件，均本地通过）。
Harness selection 见 `verifications/F-009/test-selection.json`。
