# P03-9 / F-014 Run/Batch 控制、retryFinal 与恢复诊断 Host 接线

日期：2026-10-19。状态：命令/查询/事件通道已接入现有 HostClient；未新增传输层，
未改变冻结线消息版本。Core 授权与事务语义仍为唯一权威。

## 1. 目标与边界

把前序已实现并已由 Host 通用路由接线的控制能力暴露为 HostClient 公共方法，
同时补齐查询响应与 SSE 事件的客户端线校验：

- 命令：`execution.pause`、`execution.cancel`、`execution.resume`、
  `execution.retryFinal`；
- 查询：`execution.run.control.get`、`execution.batch.control.get`、
  `execution.run.recovery.get`；
- 事件：既有 `execution.run|batch.paused`、`execution.run|batch.cancelling`、
  `execution.run|batch.cancelled`、`execution.run|batch.resumed` 等脱敏事件。

不新建 HTTP 服务、回执库、事件总线或第二套命令通道；HostClient 只访问既有
`POST /v1/commands`、回执/结果读取、GET 查询与 `/v1/events` SSE，不打开
SQLite、不读取业务文件。`execution.retryFinal` 继续复用 F-009/F-010 的资格
重算与受限 finalization scope，不由客户端携带预算/状态/scope。

## 2. HostClient 入口

| 方法 | 操作 | 输入校验（零网络拒绝） |
| --- | --- | --- |
| `pauseExecution(input, options?)` | `execution.pause` | projectId、UUID v4 的 runId/batchId 恰一、expectedRevision ≥ 1、可选 commandId |
| `cancelExecution(input, options?)` | `execution.cancel` | 同上 |
| `resumeExecution(input, options?)` | `execution.resume` | 同上（恢复模式 `auto/new/required` 仍由 Task 策略/输入快照决定，不由命令 payload 注入） |
| `retryFinalExecution(input, options?)` | `execution.retryFinal` | projectId、featureId、historicalRunId、受限 workKey（非空 ≤256）、可选 commandId |
| `getRunControl(projectId, runId)` | `execution.run.control.get` | 稳定 ID；响应归属 run/batch 关系复核 |
| `getBatchControl(projectId, batchId)` | `execution.batch.control.get` | 稳定 ID；响应归属 batch 关系复核 |
| `getRunRecovery(projectId, runId)` | `execution.run.recovery.get` | 稳定 ID；run/batch 归属复核 |

控制命令 payload 恒为 `{runId: string|null, batchId: string|null}` 且恰一非空；
actor/principal/permissions/status/budget/stop 结果等提权或服务端决定字段作为
未知键在任何请求前拒绝。`commandId` 与 `issuedAt` 可经 `SubmitCommandOptions`
复用原信封，同摘要返回原回执，异摘要保持既有 conflict。

## 3. 线协议与版本

- `CURRENT_SCHEMA_VERSION` 保持 `5`：本 Feature 只新增客户端方法与既有操作
  的响应/事件校验分支，未修改任何已冻结消息形状；不猜测升版。
- `APPLICATION_COMMAND_CAPABILITIES`/`APPLICATION_QUERY_CAPABILITIES` 与 Core
  `COMMAND_OPERATIONS`/`EXECUTION_CONTROL_QUERY_OPERATIONS` 同源，握手能力与
  HostClient 已一致宣告；旧/未知握手版本仍 `unsupported_schema_version`。
- 查询响应新增冻结字段集校验：未知键、未知 schemaVersion、未知 nextAction、
  伪造 finalization、把未知用量/停止确认写成 0/false 均 `response_malformed`。
- SSE 事件补执行域脱敏 payload 分支（`paused/resumed/cancelling/cancelled`、
  `dispatched`、`budget.revised`、Task/Attempt/审批/交付/Git/工作区事件），
  与 Core `mapStateEvent` 同一形状；不再把合法事件误判为 settingsSummary 或
  未知 payload。

## 4. 可观察性与断开语义

- 命令 completed/rejected 回执原样返回；accepted 类能力仍只经既有 Work
  accepted/回执校验，不把 accepted 宣称为已暂停/已停止/已验收。
- 最终状态、原因、关联 Attempt/停止 operation/租约与显式后续动作经控制查询
  读取；恢复来源、请求/实际模式、finalization scope、累计预算与四轴事实经
  恢复查询读取。
- SSE 只观察持久事件：订阅关闭、断线重连或 HostClient 停止 follow 不发送
  stop/cancel，不改变后台执行；取消/暂停仍必须显式命令。

## 5. 聚焦验证

`test/modules/host/control/p03-9-f014-host-control-wiring.test.ts`（真实 Host + SQLite + 真实传输，
零模型）：能力/握手/旧版本拒绝；pause→query→event、重复 commandId、revision
冲突、resume、cancel、Batch 目标；跨项目 forbidden、未认证 401、过期
`command_expired`、未知操作 501、受限主体无能力拒绝、客户端互斥目标/非法 UUID/
未知键拒绝；SSE 断开不取消；retryFinal 创建受限新 Run、旧 Run 保持终态、恢复
查询展示零编码 scope/累计预算/分轴；未知键/版本/动作/伪造 finalization/零用量
被线校验拒绝。

回归覆盖既有 SSE/客户端/计划纵向、F-013 控制查询、Host 生命周期能力与 Feature
分轴查询。Feature 全量门禁由 Nezha 独立执行。
