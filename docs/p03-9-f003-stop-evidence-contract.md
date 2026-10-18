# P03-9 / F-003 取消接入 Runtime/Verifier 停止与证据契约

状态：已实现（2026-10-18）。前置：F-002 的 `execution.cancel` 回执与持久
`execution_stop_operations`。本契约覆盖取消提交后的真实停止接入、停止证据与
停止未确认时的隔离；不新增通用进程管理器。

## 1. 边界与顺序

1. `execution.cancel` 在同一短写事务持久化取消意图、目标状态、停止 operation 与
   回执；事务提交前不触碰 Runtime/Verifier。
2. 提交后仅当回执关联的新 operation 为 `stopping` 时调用受信停止控制
   `ExecutionStopControlPort.stop({ projectId, stopOperationId })`。重复 commandId、
   重放、终态 `already_terminal` 与已有 `uncertain` operation 不重新停止。
3. 停止控制从持久 operation 读取目标，不信任请求输入；按 Run/Batch 关联的活动
   Attempt（`preparing/executing/verifying`）请求停止。

## 2. 复用的既有停止端口

- Runtime：`ExecutionService.cancel(identity)`；底层仍是受监督 `CommandProcess`
  的单一有界路径：请求停止 → 宽限 → 持久身份核对（PID/PGID/OS lstart/launch
  身份）→ 必要升级 → 受控组与子进程缺席核验。
- Verifier：`VerificationStopControl` 把 `AbortSignal` 交给既有
  `CommandProcess.start`，因此复用同一宽限/身份核验/升级/整组缺席路径。
  验证登记按 `projectId/runId/batchId/attemptId/executionVersion/operation`
  匹配；停止请求只中止匹配批次并在有界预算内收集逐检查证据。
- 受控子进程不属于新的停止实现；本 Feature 不接管无关进程。

## 3. 停止 operation 结算

迁移 v29 为 `execution_stop_operations` 追加：

- `evidence_ref`：停止证据 Artifact 引用；
- `stop_confirmed` / `forced` / `checked_at`：核验结果与核验时刻。

状态只允许 `stopping → stopped|uncertain`（已结算的 operation 原样返回，不
倒写、不覆盖证据）。`uncertain` 不能被后续调用自动改回 `stopped`。

- 全部 Runtime/Verifier 观察确认停止：operation=`stopped`；且目标已无活动
  Attempt、无租约时，目标/所属 Run 收尾为 `cancelled` 并追加既有取消事件。
- 任一观察未确认、身份不符、旧组不可核对、探测失败或仍可能写文件：
  operation=`uncertain`；仍活动的 Attempt 标记 `interrupted`，其 held 租约转为
  `quarantined`，**不释放占用**；Run/Batch 保持 `cancelling`（新认领/派发/启动
  继续被拒绝）。

## 4. 证据 Artifact

`kind=execution-stop`，`schemaVersion=1`，包含：

- 身份：`projectId/stopOperationId/targetKind/targetId/batchId/runId`；
- 时间：`requestedAtUtc/checkedAtUtc`；
- 结论：`outcome=stopped|unconfirmed`、`stopConfirmed`、`forced`（true=观察到
  强制终止，null=无法判定，绝不填 false 冒充未升级）；
- 每个 Attempt：owner/host/executionVersion、`executionStage`、观察到的
  status、`state=stopped|unconfirmed|not_started`、`exitCode/signal`、结算
  Artifact 引用与 `gaps`；
- 每个 Verifier 批次：逐检查 `launched/stopConfirmed/exitCode/signal/forced/
  reason/gaps`；
- 聚合 `gaps`（如 `runtime_stop_unconfirmed`、`verifier_stop_unconfirmed`、
  `verifier_stop_wait_timeout`、`stop_not_observed`、`occupancy_retained`）。

未知退出码/信号/强制停止一律为 `null`，不填 0/false。证据经既有 Artifact
存储发布，持久状态经 `AtomicCommandStore.getExecutionStopOperation` 查询。

## 5. 验收要点

- 真实临时资源分别挂起 Runtime 与 Verifier；忽略 SIGTERM、父进程退出但子进程
  仍写文件的受控组只有在整组确认缺席后才释放；tracked/untracked 文件与已收
  输出保留。
- 身份失配/探测失败使用真实受控进程：不发送任何信号、不误杀无关进程、不误报
  `stopped`；测试自行核对并在 finally 有界清理自有进程。
- 停止未确认后竞争 Work/baseline（租约仍在）与 resume（Run/Batch 仍
  `cancelling`）不能启动；迟到旧 owner/version 结算只落诊断，不倒写状态。
