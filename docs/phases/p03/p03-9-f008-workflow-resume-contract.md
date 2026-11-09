# P03-9 / F-008 显式工作流 resume 契约

状态：已实现（P03-9 / F-008）。本契约描述 Core 的重新授权与原现场复用；不表示
Pi SDK/native resume 已接入。

## 1. 命令面

- 操作：`execution.resume`（project scope、`mutation=update`、能力
  `execution.start`）。
- payload：`{ runId, batchId }` 恰一个非空；`expectedRevision` 位于信封顶层，
  是目标 Run 或 Batch 自身 revision。
- 幂等：同 commandId 重放返回原 completed/rejected 回执，不重复事件/唤醒；
  异摘要、过期 revision、跨项目或无权限按既有命令面拒绝。
- 不新增迁移；不创建 Attempt/Session/worktree，不启动 Runtime，不改预算、
  deadline 或累计计数。

## 2. 重新授权（写事务之外）

只接受可继续的非终态目标：

- Run：状态必须为 `paused`；父 Batch 可为 `queued/running/paused`；
- Batch：状态必须为 `paused`，且恰有一个非终态 paused Run；
- 终态 `succeeded/failed/cancelled` 返回 `already_terminal`；`cancelling`
  返回 `cancelled_not_resumable`；`interrupted` 返回 `recovery_unsafe`；
  `pausing`/活动 Attempt/遗留 held/quarantined 租约返回 `occupancy_unresolved`；
  `queued/running` 返回 `not_resumable`。

同一只读视图内重核：

1. 项目 active、Phase open；
2. 计划批准与当前检查政策有效；Task 策略/权限/必需输入身份与授权快照一致；
3. 依赖、Task 状态与 passed 证据：passed 但证据失效返回 `evidence_invalid`，
   失败/跳过/等待依赖返回 `dependency_blocked`；
4. worktree：受管工作区存在时经既有受界 inspector 核对 repo/branch/canonical
   路径；已有历史 Attempt 却没有工作区返回 `workspace_invalid`；从未启动的首次
   执行允许无工作区；
5. 预算与 deadline：Batch 计数/绝对 deadline 或 Run 上限耗尽返回
   `budget_exhausted`；resume 不退还/重置任何计数；
6. 启动恢复门控未开放返回 `startup_recovery`。

DAG 在“解除暂停”的只读预演上决定缺失步骤：
`coding`（存在就绪 Task）、`final_verification`（全部 Task 有效 passed）或
`approval`（仅人审/收尾缺失）。approval 不唤醒调度器；所有拒绝均保存
rejected 回执（可查询原因），不解除暂停、不写 resume 事件、不启动 Runtime。

## 3. 原子提交与后续认领

短写事务内重核目标 revision/状态、Batch/Run 预算、授权/策略/输入摘要、占用与
工作区 id/revision，然后在同一事务内：

- Run 目标：Run `paused → queued`，清 `pause_requested_at/reason`；若父 Batch
  paused/queued 则转 `running`；
- Batch 目标：paused Run 转 `queued`，Batch `paused → running`；
- 追加 `execution.run.resumed` / `execution.batch.resumed`（payload 恒
  `{resumed:true}`）与 completed 回执。

提交后仅对 `coding`/`final_verification` 经既有调度唤醒端口发出信号。真正的新
Attempt、输入快照持久化、owner/version、预算预占与租约仍由既有 claim 事务原子
创建；resume 不是认领、不是 Runtime 启动，也不是 Task passed。

## 4. 边界

- 同 Task 在原受管 worktree 增量继续，保留代码、Task/Run/Batch 累计计数与
  passed 证据；已 passed 且证据有效的 Task 不重编码；
- 新 Attempt/invocation/Session 与原 Session 来源分离；同一存活进程内网络重试
  不新建 Attempt，真实新进程启动继续使用既有 runtime-start 预占键；
- 不实现 Pi SDK/native resume、跨 provider 历史互通或原生库打开/复制；
- 人审批准本身不启动运行；仅人审缺失的 Run 经显式 resume 只进入 approval
  缺失步骤；
- 取消后的终态不因 resume 复活；未知停止/占用未收尾时任何模式都不能绕过。
