# F-012 Git 故障与 worktree 现场保护

F-012 登记真实 Git 提交故障、持久 operation 恢复和临时 worktree 负例。测试在受管临时资源中运行，并在 fixture teardown 前把 Git、SQLite operation、检查摘要、审批和清理状态写入独立 evidence 目录。

覆盖范围：

- `p03-10-git-worktree-negatives.test.ts` 验证确认基线、分支/目录/HEAD 身份、幂等复用、tracked/untracked 现场、空 stash 和受管临时 worktree 的保留。
- `p03-10-git-faults.test.ts` 验证检查后源码变化、缺少人工审批、合法提交后新增阻塞，以及提交前故障和提交后回执落库故障的恢复幂等性。
- `p03-10-task-commit-failure.test.ts` 的 F-012 cases 验证 commit hook 在工作区和暂存区改变源码时，旧检查代码摘要与 candidate tree 不能直接完成 Task；真实 HEAD/tree、operation 和后继 Task 状态分别保留。

本地运行证据位于 `verifications/F-012/runtime-logs`，完整场景证据位于 `verifications/F-012/evidence`。任务索引为 `test/index/phases/P03/features/P03-10/tasks/F-012.json`；该索引登记的既有 acceptance 文件包含未在本轮逐个重跑的历史负例，不能把它们计入本地已通过结果。
