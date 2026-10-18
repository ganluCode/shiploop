# P03-9 / F-001 Run/Batch Task 边界暂停契约

状态：已实现（2026-10-18）。本契约只覆盖 Task 边界暂停；取消、停止核验、resume
与 retryFinal 由后续 Task 交付。

## 1. 命令

命令名：`execution.pause`。project scope，复用既有 `execution.start` 授权面，
更新类信封必须携带 `expectedRevision`（目标 Run/Batch 自身 revision）。

```json
{
  "schemaVersion": 5,
  "commandId": "<uuid-v4>",
  "operation": "execution.pause",
  "scope": { "kind": "project", "projectId": "<project-id>" },
  "expectedRevision": 1,
  "issuedAt": "<ISO UTC>",
  "payload": { "runId": "<uuid-v4>", "batchId": null }
}
```

`payload` 恰好提供一个非空目标：`runId` 或 `batchId`（另一键可为 `null`/缺省）。
服务端决定字段（status/reason/changed/eventId）不能经请求输入。

## 2. 状态与持久化

- 无活动 Attempt（preparing/executing/verifying）：目标进入 `paused`。
- 有活动 Attempt：目标进入 `pausing`；当前 Attempt 可完成 Runtime/验证/必要
  获准收尾，全部活动 Attempt 结束后由 Attempt 生命周期同事务收口为 `paused`。
- Batch 暂停同时标记其活动 Run；之后重试也不会创建新 Run。
- `pause_requested_at`（迁移 v27，runs/execution_batches 追加列）保存持久暂停
  意图；`reason='user_pause'`。验证/审批路径不能因收尾把 Run 自动恢复 running。
- 终态（succeeded/failed/cancelled）只返回 `already_terminal`，不写状态、不增生
  事件；`interrupted` 保留原隔离状态；`cancelling` 拒绝暂停。
- 暂停不修改预算快照、budget_revision、deadline、累计计数、Attempt 历史或代码。

## 3. 事务、幂等与事件

- 项目可见性、目标归属、revision CAS、暂停意图、状态和事件在同一 SQLite
  `BEGIN IMMEDIATE` 短写事务内提交；同事务保存 completed/rejected 回执。
- 重复 `commandId` 返回原回执；同 ID 异摘要、过期 revision、跨项目目标和无权限
  请求拒绝。revision 失配返回稳定 rejected（`reason=stale_revision`），零业务写入。
- 事件：`execution.run.paused` / `execution.batch.paused`，payload 恒
  `{"paused":true}`，分别聚合目标 Run/Batch。

## 4. 调度与认领

- `TaskDag` 在 Run/Batch 有持久暂停意图或 `pausing/paused` 控制状态时返回
  `run_control_blocked` / `batch_control_blocked`；`claimTask` 在同一事务内再次
  核对并拒绝，避免新 Attempt。
- 暂停 Batch 的重试派发被拒绝；活动 Run 仍占用唯一活动位，不能借新 Run 绕过。
- 暂停不清预算、不延长 deadline；恢复必须由后续显式 resume 控制重新核验授权。

## 5. 迁移与验证

迁移 v27 只在最新迁移之后追加两列，既有迁移 SQL/checksum 不变。空库与前序
v26 库升级均保留既有数据。聚焦测试见
`test/p03-9-f001-execution-pause.test.ts`（真实临时 SQLite、认领/验证生命周期、
重复/异摘要/过期 revision/终态/跨项目/权限负例、预算与 deadline 不变）。
