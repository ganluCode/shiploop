# P05-4 F-008 派发纵向验收证据

- 受测分支：`feat/p05/concurrent-dispatch`
- 受测 commit SHA：`640fe2c`
- 测试索引：`test/index/phases/P05/features/P05-4/tasks/F-008.json`
- selection manifest：Harness `verifications/F-008/test-selection.json`

## 已执行

| 项目 | 实际命令 | 退出码 | 证据 |
|---|---|---:|---|
| F-008 聚焦测试 | `/Users/ganlu/.local/pipx/venvs/nezha/bin/python -m nezha.dag.test_command --log-dir /Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-23-18-55-21_p05-4-feature/verifications/F-008/runtime-logs -- node scripts/run-tests.ts test/modules/execution/dispatch/p05-4-f008-feature-dispatch-vertical.test.ts` | 0 | `verifications/F-008/runtime-logs/test-vdq8j9e2.log` |
| 类型检查 | `npm run typecheck` | 0 | Harness `tool-logs/f008-typecheck-commit.log` |
| 架构边界检查 | `npm run check:boundaries` | 0 | Harness `tool-logs/f008-boundaries.log` |
| 构建与入口 smoke | `npm run build` | 0 | Harness `tool-logs/f008-build.log` |
| selection 路径校验 | `node -e '<selection validator>'` | 0 | Harness `tool-logs/f008-selection-validation.log` |

聚焦测试结果为 1 个测试文件、2 个用例通过。第一用例使用真实临时 SQLite 派发候选、真实 Git worktree 和可控屏障：A/B 在两个调度 worker 中进入消费，C 由持久 DAG 原因 `dependency_pending` 保持等待；第二用例使用生产组合根验证重复唤醒、Host 重建和 SQLite Attempt/Runtime 预算不重复。测试自身创建的 worktree 在 `finally` 中移除。

## 范围边界

selection 共登记 8 个完整测试文件。当前 Runtime 只执行新增 F-008 文件；以下 7 个已登记的 P04/P05 受影响回归交由 Nezha 独立验证，当前记录为 `not_run`：

- `test/modules/execution/dispatch/p04-9-f010-dispatch-vertical.test.ts`
- `test/modules/scheduling/p05-4-f004-feature-scheduler.test.ts`
- `test/modules/recovery/p05-4-f006-dispatch-recovery.test.ts`
- `test/modules/workspace/p05-4-f005-feature-workspace-concurrency.test.ts`
- `test/modules/scheduling/p04-9-f004-dispatch-task-claim.test.ts`
- `test/modules/scheduling/p04-9-f006-dispatch-control-settlement.test.ts`
- `test/modules/recovery/p04-9-f007-dispatch-startup.test.ts`

未运行全仓历史回归、Phase 验收命令、真实模型/网络或付费模型。测试索引和报告不把这些项折算为通过，也没有清除人工阻塞或修改官方 Task/Feature 元数据。
