# P08-2 F-005 Todo live 负例夹具

`scripts/acceptance/p08-todo-live-negatives.ts` 提供确定性故障夹具，验证 live 编排器的失败边界。它只模拟受控故障和持久证据，不调用 Pi、不修改正式 Task/Feature 状态，也不把 FakeRuntime 当成正常交付成功。

夹具覆盖：

- 缺认证、认证拒绝：在认领 Task 和创建 worktree 前停止；缺认证记录 `not_run`，认证拒绝记录失败。
- 前置 Task 失败、预算耗尽：只为前置 Task 创建一个部分 worktree 和 Attempt，后继 Task 记录 `dependency_not_passed`，不生成代码、不提交。
- 取消：保留部分代码、Attempt、预算和失败证据；确认停止后释放占用，但 worktree 仍保留供后续核对。
- 未确认中断：保留部分代码和占用；`resumeTodoLiveNegative` 返回 `old_process_not_confirmed`，不创建新的 Attempt 或 worktree。

每个场景在临时根下保存 `state/<scenario>.json` 和 `evidence/<scenario>.json`。`auditTodoLiveNegative` 同时读取两份持久记录和实际 `worktrees/<taskId>/partial.txt`，核对身份、依赖副作用、预算边界和清理结果。报告只引用临时根内的相对路径，不包含凭据或开发机绝对路径。

这些是 unit 范围的受控夹具。真实 Pi、Host、SQLite、Git worktree、进程停止与 Phase 组合验收仍由独立 live/Phase 集成入口执行，未运行项不能折算为通过。
