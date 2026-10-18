# P03-9 / F-009 retryFinal 资格与受限 finalization scope 契约

日期：2026-10-18。状态：已实现 Core 只读资格判定与 scope 计算；不创建 Run、不启动 Runtime，Host/CLI 接线由后续 Task 交付。

## 1. 目标与边界

`execution.retryFinal` 用于「所有 Task 已完成，但最终检查、审批或提交失败」时只继续缺失的收尾步骤。本 Task 只回答两件事：

1. 显式请求是否具备 retryFinal 资格；
2. 如果具备，受限 finalization scope 仍缺哪些检查/审批/提交步骤。

本 Task **不**：

- 创建 Batch/Run/Attempt/Session；
- 启动 Runtime 或运行检查；
- 扣减/重置预算、写事件/回执；
- 把失效证据自动转成新的编码 Attempt；
- 重开历史终态 Run/Attempt 或改写历史 passed 记录。

实现：`packages/core/src/application/finalization-retry.ts`；契约词汇：`packages/core/src/ports/finalization-retry.ts`。

## 2. 输入身份

请求只接受：

- `projectId`：同项目；
- `featureId`：同 Feature；
- `historicalRunId`：明确的历史终态 Run（不复用「最新 Run」猜测）；
- `workKey`：历史 Run/当前计划与输入身份一致的工作键。

同一 Run 还必须满足：属于请求 Project/Feature/Batch、用途为 Work 执行、状态为 `succeeded` / `failed` / `cancelled`。当前工作区来自 Core 受管 `managed_workspaces`，经受界 `WorkspaceInspector` 核对 repo 身份、分支、规范路径与当前 HEAD。

## 3. 拒绝原因

| reason | 含义 |
| --- | --- |
| `run_not_found` | Run 不存在或不属于请求项目 |
| `identity_mismatch` | Feature/Run/Batch 归属不一致 |
| `work_key_mismatch` | 请求 workKey 与历史 Run/当前计划输入身份不一致 |
| `run_not_terminal` | 历史 Run 仍活动/暂停/停止中 |
| `unsupported_run_purpose` | 历史 Run 不是 Work 执行用途 |
| `project_not_active` | 项目当前非 active |
| `authorization_invalid` | 当前计划批准/检查政策/Phase 失效 |
| `tasks_not_passed` | 仍有必需 Task 未 passed（收尾不能修复编码） |
| `occupancy_unresolved` | 旧 Attempt/租约仍活动、隔离或未确认停止 |
| `workspace_invalid` | 受管 worktree 缺失、身份不符或检查失败 |
| `already_finalized` | Feature 已完成且所有轴当前证据有效 |

成功 workKey 不会自动派发重跑；只有显式 retryFinal 请求才进入本判定。

## 4. 证据复用

对每个 Task，以最新非 `FeatureVerification.full` VerificationBatch 和最新 Attempt 核对：

- **代码**：批次 `codeDigest` 必须等于当前 worktree `codeDigest`；
- **需求**：当前 `planDigest`、当前输入解析身份与历史 Run/Attempt 快照一致；workKey 由当前计划与输入重算；
- **配置**：Task 当前策略副本摘要必须等于历史 Attempt 的 `strategyCopyDigest`；
- **环境**：批次 `environmentSummary.workspace` 存在时必须与当前 HEAD/codeDigest 一致；检查定义的 `environmentRef` 变化按检查定义变化处理；
- **检查定义**：批次检查快照与当前项目有效 `checkDefinitions` 逐项相同（scope/argv/cwd/environment/timeout/required/requirementRefs）；
- **Artifact**：Task 代码证据、逐检查输出、Feature 最终检查输出与审批引用必须经 `ArtifactVerifier` 完成文件级完整性核对。

结论只作用于「当前可复用证据」：

- 有效 Task 进入 `retainedTaskIds`，其历史记录不变；
- 失效 Task 进入 `revalidateTasks`，只列出相关检查键与原因；
- 任何 Task 待重验都会要求重跑 Feature 最终检查，但不会创建编码 Attempt。

## 5. 最终检查、审批与提交

- **最终检查**：最近 `FeatureVerification.full` 必须 passed、绑定当前 codeDigest、检查定义/环境/Artifact 完整；否则输出当前全量回退检查键。
- **审批**：只认可同时绑定当前 `planDigest` 与当前代码摘要的有效 `approval` 事项；历史批准、其他代码摘要批准、未解除的人工阻塞均不构成当前批准。解除阻塞不等于重跑。
- **提交**：已观察到成功提交时不重复提交；`deliveryStatus=pending` 或提交 operation 仍 pending 时只输出 `reconcile_commit`；已发生但状态不一致时也先核对；未提交才输出 `commit`。

`missingSteps` 稳定顺序：`task_revalidation` → `feature_verification` → `approval` → `reconcile_commit` / `commit` → `finalize`。

## 6. 输出不变量

- `coding.taskIds` 恒为空，`runtimeStarts=0`，`newAttempts=0`；
- `historicalRecordsMutated=false`；
- 历史 Run/Attempt/VerificationBatch/CheckResult/审批/策略快照由 `BEGIN DEFERRED` 只读事务读取，本模块无写原语；
- 取消历史不会自动继续；本模块只响应显式请求并重新核验授权与副作用。

## 7. 聚焦验证

`test/p03-9-f009-finalization-retry.test.ts` 使用真实临时 Git/SQLite/Artifact：

- 相同输入重复计算不改变任何历史行；
- 源码变更只使当前 Task/最终检查证据待重验；
- 检查定义变更只影响引用该定义的 Task；
- 输出 Artifact 缺失/损坏使相关证据待重验且历史行不变；
- 错误 workKey/项目、非终态 Run、旧租约隔离均明确拒绝；
- 历史代码批准不构成当前批准，也不触发重跑；
- 取消历史仅在显式请求下做只读资格重核。

本 Task 不执行 Feature 全量门禁；由 Nezha 独立执行。
