# P03-9 / F-012 finalization-only Run 审批继续与完成契约

日期：2026-10-18。状态：已实现 Core 应用编排与受信 Git 交付适配器；Host/CLI 入口由 F-014/F-015 交付。

## 1. 目标与边界

F-011 完成必要重验/最终检查后，finalization-only Run 仍缺最终审批、提交和完成 CAS。
本项只继续这些缺失步骤：

- 审批缺失时保持等待，不重复编码、不无条件重跑有效检查；
- 批准命令只更新审批；显式 `execution.resume` 后才重新核对代码身份、授权与预算；
- 提交前复用持久 Git operation 与真实 HEAD/tree 事实；
- 已发生提交只核对复用，无差异记录 `no_change`，不重复提交同一成果；
- 全部轴满足才原子完成 Run/Batch/Feature；
- 不实现 push/PR、不自动合并分支、不启动 Runtime/Attempt。

实现：

- 契约词汇：`packages/core/src/ports/finalization-completion.ts`；
- 应用编排：`packages/core/src/application/finalization-completion.ts`；
- 受信 Git 交付适配器：`packages/core/src/application/finalization-git-delivery.ts`；
- 调度接线：`WorkSchedulerOptions.finalizationCompletion`（handoff 已记录、Run 仍
  `queued/running` 时调用；不替代 F-011 handoff）；
- finalization-only Run 的 `execution.resume`：跳过编码 DAG 预演，只重核全 Task
  passed、计划授权/检查政策、工作区和预算；审批/提交仍由本服务重核。

## 2. 审批轴

1. 用 F-009 planner 重算当前 scope：代码/HEAD/检查政策/工作区身份必须与
   finalization Run 持久 scope 一致；除已由交付 operation 解释的提交后 HEAD
   推进外，任何漂移都使结果失效。
2. `revalidateTasks`/`finalVerification` 仍缺失时返回 `verification_required`，
   不自动执行检查，也不进入提交。
3. 最终审批无效时：
   - Run 仍活动 → 通过既有 `finalizeFeatureDelivery` 写
     `awaiting_approval`，Run/Batch 转 `paused`；
   - Run 已暂停 → 幂等返回等待，不重复写事件。
4. `task.approval.approve` 只更新审批事项；不会唤醒执行、不会提交。用户必须
   显式 `execution.resume`。
5. 显式继续后本服务再次调用 F-009 planner，并重新检查 Batch/Run 预算、
   deadline、暂停/取消意图和工作区身份。

## 3. Git 提交轴

提交身份使用历史 Attempt/Run（Git operation 必须与该 Attempt 归属一致），
finalization Run 只是控制信封；不启动该 Attempt。

- 先按持久 scope 的 commit operation/确定性 operationId 读取既有 operation。
- `succeeded`/`no_change`：只核对真实 HEAD/tree/parent/message 与源码身份；
  一致则复用，不一致则 `invalidated`，不 reset。
- `pending`：只调用受信 reconcile；`matched` 复用，`not_executed`/未知保持
  `reconcile_required`，不再次提交。
- `failed`：可生成新的 operationId 重试同一受控提交；不修改历史失败回执。
- 新提交：受控 driver 暂存/提交/核对 tree、HEAD、parent、消息和身份；hook
  改源码、外部 HEAD 漂移或 tree 不一致都不得完成。
- `no_change` 是明确 operation 终态，不捏造 commit；deliveryStatus 仍为
  `succeeded`。
- 提交异常默认视为结果未知（`pending`/`reconcile_required`），不盲目重试。

## 4. 完成 CAS

只有以下全部满足才调用既有 `finalizeFeatureDelivery`：

- Run/Batch 仍活动且未暂停/取消，预算与 deadline 允许；
- 当前 scope 身份一致，Task/最终检查证据当前有效；
- 当前 planDigest + 当前代码摘要审批有效；
- 要求的提交已 `succeeded`/`no_change`（或既有成功提交核对一致）。

完成事务使用 Feature/Run/Batch revision CAS；取消竞争、旧回执或 revision
冲突返回 `control_interrupted`，不覆盖当前终态。提交失败/未知时 Run 以
`failed` 终态保留现场，Feature 保留分轴结果（partial + deliveryStatus
`failed`/`pending`），不标记 completed。

`FinalizationCompletionResult` 固定携带审批轴、提交轴、缺失步骤和
`runtimeStarts=0`/`newAttempts=0`，供 F-013 查询映射；不新增第二套业务事实源。

## 5. 聚焦验证

`test/p03-9-f012-finalization-completion.test.ts`（真实临时 Git/SQLite/Artifact，
零模型）：

- 无差异记录 `no_change` 并完成，不新增提交/Runtime/Attempt；
- 审批缺失等待，批准命令不提交，显式 resume 后才完成；
- 提交失败不触发 Runtime，新 finalization Run 只重试失败提交；
- 提交成功但回执丢失只按真实 Git 事实 reconcile，不重复提交；
- hook 改源码、外部 HEAD 漂移不完成、不 reset；
- 提交后取消竞争与旧回执不覆盖当前终态；
- 非 finalization Run 零副作用。

Feature 全量门禁由 Nezha 独立执行。
