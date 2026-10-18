# P03-9 / F-011 finalization-only Run 执行契约

日期：2026-10-18。状态：已实现 Core 应用编排、调度/认领边界与受信 Node Verifier 适配器；
审批、提交和 Feature 完成仍由 F-012 交付。

## 1. 目标与边界

显式 `execution.retryFinal` 创建 finalization-only Run 后，本项只负责：

- 按 F-009 scope 对失效 Task 证据执行必要重验；
- 对当前最终代码执行 Feature 全量检查；
- 把真实批次、检查结果与 Artifact 证据落库；
- 失败/失效/控制中断时保留现场和证据。

不创建 Run/Attempt/Session/worktree，不启动 Runtime，不调用模型，不执行审批或 Git，
不把 `verification_passed` 当成 Feature completed。编码 Task、新 Attempt 与 Runtime
启动恒为零。

实现：

- 契约词汇：`packages/core/src/ports/finalization-execution.ts`；
- 应用编排：`packages/core/src/application/finalization-execution.ts`；
- 受信 Node Verifier 适配器：`packages/core/src/application/finalization-node-verifier.ts`；
- Run 分流：`work-scheduler` / `assembleWorkExecution`；
- 受信装配入口：`CoreApplicationOptions.finalizationExecution`。

## 2. 输入与身份

Run 必须满足：

- `input_snapshot.finalization.schemaVersion=1`、`kind='finalization-only'`；
- Run 属于同 Project/Feature/Batch 且用途为 `execute`；
- `codingTaskIds=[]`、`runtimeStarts=0`、`newAttempts=0`；
- Run/Batch 仍活动（`queued`/`running`），无暂停意图，未过 Run/Batch deadline；
- 当前受管工作区 id/revision 与 scope 一致。

编排随后复用 F-009 planner 重算资格，要求计划摘要、代码摘要、HEAD、检查政策摘要、
工作区 id/revision 与创建 Run 时一致，且重验 Task/检查键、最终检查 required/检查键
仍与 scope 完全相同。审批/提交轴后续变化不影响检查范围，由 F-012 重新核对；任何
检查范围或代码身份漂移只使本次结果失效，不借用旧成功或旧 passed。

## 3. 执行顺序

1. 按 scope `revalidateTasks` 顺序执行 Task 重验；每项只允许 scope 列出的检查键。
2. scope 要求时执行一次 Feature 全量检查；检查键来自当前 full fallback 政策。
3. 检查后再调用 F-009 planner 重算当前 scope，要求：
   - 代码/HEAD/检查政策/工作区身份未变化；
   - `revalidateTasks` 已清空；
   - `finalVerification.required=false`。
4. 成功只返回 `verification_passed` 与剩余 `missingSteps`（审批/提交/finalize）；
   Run 保持活动，等待 F-012 显式继续。

任何步骤失败都通过既有 `settleExecutionRunOutcome` 原子结算 Run 为 `failed`：
不删除 worktree，不改写 Task passed，不删除新旧 VerificationBatch/CheckResult/Artifact。

## 4. 证据 fail-closed

每项重验/最终检查必须满足：

- `VerificationBatch.status='passed'` 且归属当前 Project/Feature/历史 Run；
- Task 重验 operation 不是 `FeatureVerification.full`；最终检查 operation 必须是它；
- 批次 codeDigest 与检查政策摘要等于 scope；
- 检查结果与 scope 检查键一一对应；`not_run`、`failed`、`error`、`inconclusive`
  或缺结果均失败；
- 每项结果有 `resultId`、ready 输出 Artifact，并通过文件级 `ArtifactVerifier`；
- 零测试或未知测试数不得通过；
- 检查期间源码/检查定义变化导致 `invalidated` 或 post-scope 不一致时结果失效。

## 5. 控制与停止

- `signal`、父 Run/Batch deadline 在每次开始 Task 重验/Feature 检查前检查；
- Node Verifier 适配器复用既有受监督 CommandProcess、VerificationStopControl 与
  Artifact 证据路径；
- 持久 VerificationBatch 仍绑定历史 Attempt/Run 以满足存储身份约束，停止控制可用
  `controlRunId=finalizationRunId` 登记；
- 取消/暂停意图出现后不继续后续检查、不覆盖 `cancelling`/`pausing`/`paused` 状态、
  不写失败终态；停止与占用释放仍由既有 P03-9 停止核验路径负责。

## 6. 调度与认领边界

- scheduler 在读取 Run 后、读取 DAG/准备认领前识别 finalization-only Run；
- 未装配 finalization 消费者时记录 `feature_finalization_consumer` capability gap；
- 已装配时调用 finalization 执行，成功后才记录一次性
  `feature_final_verification_handed_off`，后续扫描不重复执行；
- 控制中断不记录 handoff，显式 resume 后仍可继续；
- `prepareClaim` 对 finalization-only Run 直接拒绝 `finalization_only_run`，不准备
  workspace、不创建编码 Attempt、不启动 Runtime。

## 7. 聚焦验证

`test/p03-9-f011-finalization-execution.test.ts`（真实临时 Git/SQLite/Artifact）：

- scope 中 Task 重验 + Feature 双检查真实落库，成功不增 Runtime/Attempt；
- 受信 Node Verifier 适配器以真实命令执行两项 Task 重验与 Feature 全量检查；
- 最终检查失败保留 worktree/Task/新旧证据，Run 失败且不新建 Run；
- 缺检查、零测试、not_run 均不得完成；
- 检查期间源码变化使结果失效；
- 取消/暂停/abort/deadline 边界不继续检查、不覆盖控制状态；
- scheduler 在认领前分流，DAG/claim 均不被调用，handoff 只执行一次；
- 非 finalization Run 不执行任何重验。

Feature 全量门禁由 Nezha 独立执行。
