# F-015 Host 强杀恢复与同 Task 续接场景

F-015 将 P03-9 已实现的恢复核心接入 P03-10 的阶段选择，验证范围集中在 Host 崩溃后的保守恢复、恢复现场核对、显式续接和 Fake 能力降级。

| 验收面 | 场景与权威事实 |
| --- | --- |
| Host 强杀与恢复 | `p03-9-f016-host-kill-recovery.test.ts` 使用真实 Host/SQLite/Git/worktree 和真实受控进程组；强杀后先 fence、停止核验和恢复核对，保留 Attempt、Run、worktree 文件和预算；不自动接管，迟到结果按 owner/version fencing 丢弃。 |
| 停止不确定与 Git 副作用 | 同文件覆盖遗留工具继续写入、身份无法核对、外部 HEAD 漂移及遗留 `index.lock`；恢复状态进入 `quarantined`，不新建 Attempt 或 Runtime。 |
| 幂等显式 resume | 同文件验证并发/重复 resume 只产生一个新 Attempt、一个新 Session、一次 Runtime 启动并复用 worktree；预算快照、deadline 和累计计数保持。P03-9/F-008 覆盖 resume 的 CAS、重放回执、终态取消和已通过 Task 不重编码。 |
| 通用同 Task 决策 | `p03-9-f007-recovery-continuation.test.ts` 覆盖 `auto` 在 Fake 不支持原生续接时记录来源并降级 `new`、`new`、`required` 拒绝、输入/策略变化、跨 Attempt/占用/损坏证据拒绝，以及精简交接输入。 |
| 恢复能力边界 | `p03-10-runtime-recovery-negatives.test.ts` 覆盖能力声明证据、格式不兼容、conversation/checkpoint 区分、恢复源完整性和预算不清零。 |

本任务只声明 T40 通用决策和 Core/Fake 证据。Pi SDK 原生 resume、换模型互通、原生增量审计和 live 资源桥接不由这些场景通过；真实 SDK 相关项目仍由阶段验收记录为 `not_run`。所有真实 Host/Runtime/Verifier 夹具在 `finally` 中停止并写 cleanup 结果，测试会核验受控进程组消失。

局部选择见 `verifications/F-015/test-selection.json`。完整 Feature/Phase 回归由 Nezha 独立执行。
