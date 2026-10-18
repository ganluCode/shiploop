# P03-9 / F-010 finalization-only 新 Run 契约

日期：2026-10-18。状态：已实现 Core 命令、SQLite 原子提交、父 Batch 重开与预算扣减；不启动 Runtime/Attempt，Host/CLI 入口由 F-014/F-015 交付。

## 1. 目标与边界

全部 Task 已通过，但最终检查、审批或提交失败后，用户显式调用 `execution.retryFinal`：

- 复用 F-009 的只读资格与受限 finalization scope；
- 在同一授权父 Batch 内创建 `queued` 的 finalization-only 新 Run；
- 历史终态 Run/Attempt/Task/检查证据与既有快照零改写；
- 新 Run 消耗一次 `maxRuns` 名额，仍受无进展上限、绝对 deadline 和统一占用约束；
- 本 Task 不启动 Runtime、不创建 Attempt/Session、不运行检查/审批/Git，不增额、不延期、不新建授权 Batch。

实现：

- 契约词汇：`packages/core/src/ports/finalization-retry.ts`；
- 编排：`packages/core/src/application/finalization-retry-execution.ts`；
- 原子重开原语：`ExecutionStore.reopenExecutionBatchForFinalizationRetry`；
- 命令面：`execution.retryFinal`（project scope、create、`execution.start` 能力位）。

## 2. 命令身份与幂等

请求 payload 只接受：

```json
{ "featureId": "…", "historicalRunId": "…", "workKey": "64-hex" }
```

- `projectId` 来自命令 scope，不能经 payload 自报；
- `expectedRevision` 必须缺席（创建类）；父 Batch revision 在同一写事务内重核；
- 请求摘要与既有 `commandId` 绑定：相同 commandId 重放返回原 completed/rejected 回执，不重复创建 Run、事件或计数；
- 新 Run 的 `dispatchOrdinal` 在事务内按同 Batch/workKey 现有最大值 +1；
- 派发事件沿用 `execution.run.dispatched`（脱敏固定 payload），completed 回执携带新 Run 身份、`runsCreated`、受限 scope 摘要与缺失步骤。

## 3. 父 Batch 可继续性

准备阶段与提交事务内都检查：

| Batch 状态 | 处理 |
| --- | --- |
| `queued` / `running` / `paused` | 可继续；不改变 Batch 状态 |
| `failed` | 显式 retryFinal 允许重开为 `queued`，仅 revision/status/reason 变化 |
| `succeeded` / `cancelled` / `cancelling` / `pausing` / `interrupted` | 拒绝 `batch_not_continuable` |
| 任意 `pause_requested_at != NULL` | 拒绝 `batch_not_continuable` |
| 同 Phase 已有其它活动 Batch | 拒绝 `batch_not_continuable` |

重开不重置 `runsCreated/attemptsCreated/runtimeStarts/noProgressRuns`、预算快照、deadline、scope/config 快照或历史预算修订行；`maxRuns` 只增不减。

## 4. 事务内重核与原子提交

短写事务内按以下顺序执行，任一步失败整组回滚：

1. 项目仍 active；历史 Run 仍属于同 Project/Feature/Batch、仍为终态、用途仍为 `execute`、workKey 一致；
2. 父 Batch revision/status 与准备结果一致，无暂停意图；无同 Phase 其它活动 Batch；
3. 同 Feature 无其它活动 Run（竞争请求在此得到 `active_run_conflict`）；基线占用为空；
4. 当前计划摘要与检查政策摘要未漂移，计划批准/Phase 状态仍有效，Feature 未 completed；
5. 用当前累计计数与事务时钟重算父预算；任一维度耗尽 → `budget_exhausted`，不重开、不写事件；
6. `failed` Batch 以 `expectedRevision` CAS 重开为 `queued`；`recordExecutionRunDispatch` 原子 +1 `runsCreated`；
7. 插入 `queued` Run，写入受限 finalization scope、父 Batch 授权 `previewDigest` 作为 `scopeDigest`；
8. 追加 `execution.run.dispatched` 事件并保存 completed 回执。

新 Run 的 `inputSnapshot.finalization` 至少保存：

- `kind='finalization-only'`、完整 F-009 plan 的 `retryPlanDigest`；
- 历史 Run/Batch/dispatchOrdinal、当前 planDigest/checkPolicyDigest/headCommit/codeDigest/workspace 身份；
- `retainedTaskIds`、`revalidateTasks`（Task + checkKeys + reasons）、最终检查键；
- 审批/提交要求与 `missingSteps`；
- `codingTaskIds=[]`、`runtimeStarts=0`、`newAttempts=0`。

## 5. 预算与时间语义

- 零 Runtime 的收尾仍消耗一次 `maxRuns`；
- 不预占 `runtimeStarts`，不创建 Attempt；`attemptsCreated` 不变；
- 无进展计数按现有 Run 结算规则在收尾 Run 结束时处理，本 Task 不提前重置；
- 失败、取消、重开都不退还已用 Run 名额，也不重置 Task/Batch 累计计数；
- 预算/无进展/ deadline 耗尽时返回 rejected（`budget_exhausted`）；不自动调用 `execution.budget.revise` 或 `execution.start`，用户需另行显式增额/新建授权批次。

## 6. 拒绝原因

在 F-009 既有原因之外新增：

| reason | 含义 |
| --- | --- |
| `batch_not_continuable` | 父 Batch 取消/停止不确定/暂停意图/已成功/同 Phase 其它活动 Batch |
| `budget_exhausted` | 计数、无进展或 deadline 耗尽 |
| `active_run_conflict` | 同 Feature 已有其它活动 Run（竞争请求） |
| `stale_revision` | 准备与提交之间父 Batch revision/状态漂移 |
| `authorization_stale` | 计划/检查政策身份在准备后变化 |

证据判定失败只写 rejected 回执；不创建 Run、不修改历史 Run/Attempt/证据快照。

## 7. 聚焦验证

`test/p03-9-f010-finalization-run.test.ts`（真实临时 Git/SQLite/Artifact，零模型）：

- finalization 失败后创建受限新 Run，旧终态/证据保持不变，Batch 重开且计数/预算不被重置；
- 相同 commandId 重放不重复创建；两个竞争 commandId 只有一个成功；
- maxRuns、无进展上限与 deadline 耗尽均结构化拒绝；
- 取消终态/暂停意图的 Batch 拒绝继续；
- finalization Run 失败后再重试只递增 ordinal/runsCreated；
- 真实 SQLite 关闭重开后 Run/scope/计数/回执/事件一致；
- 错误 workKey 与遗留租约判定失败不创建执行。

Feature 全量门禁由 Nezha 独立执行。
