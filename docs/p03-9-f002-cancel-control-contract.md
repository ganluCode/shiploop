# P03-9 / F-002 Run/Batch 取消意图与终态竞争契约

状态：已实现（2026-10-18）。本契约覆盖取消意图、持久停止 operation 与终态竞争；
Runtime/Verifier 的真实停止端口、进程组核验与停止证据由 F-003 接入。

## 1. 命令

命令名：`execution.cancel`。project scope，复用既有 `execution.start` 授权面；
更新类信封必须携带 `expectedRevision`（目标 Run/Batch 自身 revision）。

```json
{
  "schemaVersion": 5,
  "commandId": "<uuid-v4>",
  "operation": "execution.cancel",
  "scope": { "kind": "project", "projectId": "<project-id>" },
  "expectedRevision": 1,
  "issuedAt": "<ISO UTC>",
  "payload": { "runId": "<uuid-v4>", "batchId": null }
}
```

`payload` 恰好提供一个非空目标：`runId` 或 `batchId`。服务端决定字段
（status/stopOperationId/stopStatus/reason）不能经请求输入。

## 2. 状态与停止 operation

迁移 v28 追加 `execution_stop_operations`，每个目标至多一条活动 operation
（`stopping`/`uncertain`；partial unique index）。operation 身份
（project/command/target/batch/run/reason/requested_at）不可变，状态只允许
`stopping → stopped|uncertain`。

- 目标无活动 Attempt 且无任何 workspace 租约：取消可直接完成，目标进入
  `cancelled`，operation 为 `stopped`；历史 Attempt 原样保留。
- 仍存在 preparing/executing/verifying Attempt，或任意 held/quarantined 租约：
  只接受请求，目标进入 `cancelling`，operation 为 `stopping`。父进程退出、
  Runtime result、accepted 回执均不是停止证据。
- 目标或所属活动 Run/Attempt 为 `interrupted`：不把无活动误判为安全，保留
  `interrupted` 与占用，operation 为 `uncertain`，结果为 `stop_uncertain`。
- Batch 取消把所属活动 Run 一并置为 `cancelling/cancelled`（interrupted 子 Run
  保留）；不创建 Run/Attempt，不扩大授权范围。
- 终态 `succeeded/failed/cancelled` 只返回 `already_terminal`，不写状态、不建
  operation、不增生事件。

## 3. 幂等、竞争与审计

- 重复 `commandId` 返回原回执，不创建第二个停止 operation；同 ID 异摘要、过期
  revision、跨项目目标和无权限请求拒绝。
- 不同 `commandId` 的重复取消复用同一活动 operation；不会把已取消目标的影响
  传播到之后创建的新 Run。
- 取消只修改目标 `status/reason/revision/ended_at`、Batch/Run 传播状态和停止
  operation；不清预算、不改 deadline、不回退累计计数、不删除代码或 Attempt。
- 终态竞争由 revision 与非终态 CAS 决定：正常完成先提交时取消返回
  `already_terminal`；取消先提交后，Run 结算/Feature 收尾不得覆盖
  `cancelling/interrupted` 控制状态。
- 事件：`execution.run.cancelling`、`execution.run.cancelled`、
  `execution.batch.cancelling`、`execution.batch.cancelled`；payload 分别为
  `{cancelling:true}` / `{cancelled:true}`。

## 4. 调度与派发

`TaskDag` 对 `cancelling/interrupted` 返回 `run_control_blocked` /
`batch_control_blocked`；`claimTask` 在同一事务内复核。显式 `retryBatchId`
不再向 `cancelling/interrupted` 父 Batch 派发新 Run。

## 5. 迁移与验证

迁移 v28 只在 v27 之后追加停止 operation 表/索引/触发器，既有迁移 SQL 与
checksum 不变。聚焦测试见 `test/p03-9-f002-execution-cancel.test.ts`：真实临时
SQLite 覆盖安全完成、活动/父进程退出、interrupted 占用保留、Batch 传播、重复
commandId/不同 ID、终态与迟到成功竞争、预算/历史不变及 v27→v28 升级。
