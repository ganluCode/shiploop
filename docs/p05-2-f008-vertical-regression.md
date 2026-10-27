# P05-2 F-008 纵向回归证据

## 范围

- 受测提交：`2bdedf521e1a5985a6f468f33e8e6675598ee38c`（`F-008: 补齐 Phase 图纵向回归证据`）。
- Harness 选择清单：`verifications/F-008/test-selection.json`。
- 仓库 v2 索引：`test/index/phases/P05/features/P05-2/tasks/F-008.json`，共登记 15 个受影响文件；其中本地执行本任务新增纵向文件，其他 14 个文件交由 Nezha 独立复验并保留在去重合集内。

## 本地执行

工作目录为当前 ShipLoop worktree，实际命令如下：

```text
/Users/ganlu/.local/pipx/venvs/nezha/bin/python -m nezha.dag.test_command --log-dir /Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-23-18-55-21_p05-2-phasefeature/verifications/F-008/runtime-logs -- node scripts/run-tests.ts test/modules/planning/p05-2-f008-phase-graph-vertical.test.ts
```

退出码为 `0`，结果为 `1` 个测试文件、`3/3` 个 case 通过，耗时约 `4.95s`。完整 stdout/stderr 与退出码证据：

- `verifications/F-008/runtime-logs/test-urdkhplc.log`
- `verifications/F-008/runtime-logs/test-urdkhplc.log.exitcode`
- `verifications/F-008/runtime-logs/test-urdkhplc.log.json`

## 覆盖行为

新增的真实临时 SQLite + Host + CLI 回归覆盖：

- A/B 无依赖、C 依赖 A/B、追加 D；A/B 状态完成后 C 仍因缺少集成证据保持阻塞。
- 环、悬空引用、跨项目引用、过期 Phase revision、活动 Batch 改图均退出码为 `1`，且 Phase revision/依赖事实保持不变。
- 失败前置产生 `dependency_failed`；同一 `commandId` 的重复信号只返回回执，不重复写入。
- Host 关闭后重启仍可查询原图，并能以同一请求摘要重放原命令；输入摘要变化不会被当作重放。
- 活动 Batch 只保留 C 的旧范围，追加 D 不获得 `active_batch_scope`；活动占用阻止 Phase 关闭。
- Batch 终止后执行 close → reopen → close → archive，归档查询仍保留 Phase、Feature、Task、Batch、成功状态及真实临时 Git 仓库内容。

## 未运行范围

本任务没有运行全仓历史回归、P05 Feature task_union 合集、Phase 验收脚本、全仓 `npm run typecheck` / `npm run build` 或真实模型/live 验证。上述项目保持 `not_run`，由独立 Nezha 验证按选择索引负责较广回归；这份证据只声明本地 F-008 聚焦测试结果。
