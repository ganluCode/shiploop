# P06-5 F-013 存量接入纵向集成交付记录

状态：Task 定向验证完成；Feature/Phase 独立验收尚未签署。

## 范围

本 Task 把 P06-1 至 P06-5 已交付的项目注册、基线身份、比较、健康查询和仓库移动能力放到真实临时 Git/SQLite/Host/CLI 场景中核对。它覆盖 FR-1、FR-2 和 core-design/09 的 T15；P06-7 的完整知识、Skills、MCP 资源演示不属于本 Task。

所有纵向测试使用隔离临时目录、真实 Git 和真实受管 Host/SQLite。没有调用模型、网络服务或真实用户凭据。旧 Nezha 目录只作为待保留的仓库文件写入测试仓库，不导入 ShipLoop，也没有执行仓库脚本或安装依赖。

## 场景与事实断言

| 职责 | 测试 | 主要事实 |
| --- | --- | --- |
| 身份与基线 | `test/modules/onboarding/p06-5-f013-brownfield-integration.test.ts` `[case:identity-baseline-compare]` | CLI 注册同一个脏 Todo 仓库；保留暂存、已跟踪未提交、未跟踪 `.nezha` 与已知失败文件；真实失败制品经 CLI 查询并用 SQLite 只读行和 SHA-256 核对；修改 Todo 后第二次基线比较为 `fixed`，旧失败制品和文件仍在。 |
| 移动与项目隔离 | 同文件 `[case:clone-move-explicit-project]` | 同一个 local remote 的两个真实 clone 生成不同 `projectId`；重复 init 返回原 ID 且不覆盖名称；查询始终带显式项目；移动确认复用原项目并递增 binding revision；移动前授权和移动后新基线的身份分开，clone B 的绑定不串用。 |
| 执行故障与竞争 | 同文件 `[case:move-baseline-barrier-and-drift]` | 环境定义变化使旧预览返回 `preview_stale` 且不产制品；缺失命令持久化 `not_run/missing_command`；轮询 SQLite 持久状态确认基线已 `running` 后，移动确认被占用阻塞，绑定、Git 文件和运行行保持事实一致；finally 只取消本场景操作并恢复本场景移动路径。 |
| 既有故障回归 | F-013 索引中的既有文件 | Host 响应丢失后查原回执、命令提交回滚、停止未确认保留占用、资源选择隔离和授权拒绝继续登记，交独立 Verifier 执行；未把未运行文件写成通过。 |

移动始终要求用户明确项目、冻结预览摘要和 `--confirm`。无 HEAD、脏范围、环境变更和既有失败都保留为身份/结果事实；失败比较缺少稳定失败身份时只能返回 `incomparable`，不能按日志成功词、退出码或失败数量自动豁免。基线检查状态与 Pi/原生 Runtime 恢复分离，移动不会恢复原生会话、清理用户代码或改变资源选择。

## 本次 Runtime 验证

受测工具链：Node 22.19.0、npm 10.9.3、Vitest 5.0.3。受测基线 commit：`cd518f95feeea560bd7add23fe6408f758e42b65`；测试执行时包含本 Task 工作树改动，最终交付 commit 以 Git 记录为准。

实际命令（在目标仓库根目录执行）：

```text
/Users/ganlu/.local/pipx/venvs/nezha/bin/python -m nezha.dag.test_command --log-dir /Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-27-15-09-56_p06-5/verifications/F-013/runtime-logs -- node scripts/run-tests.ts test/modules/onboarding/p06-5-f013-brownfield-integration.test.ts
```

退出码：0。结果：1 个文件、3 项测试通过；外围耗时约 11.9 秒。完整日志：`verifications/F-013/runtime-logs/test-3ix09df1.log`。

测试前的红灯日志保留在同一目录：`test-eln5ymza.log`、`test-5alknylo.log`、`test-68g_gy1j.log`。它们记录了测试接线修正过程，不作为通过证据。

本次还执行了文档与索引守护的定向命令：

```text
/Users/ganlu/.local/pipx/venvs/nezha/bin/python -m nezha.dag.test_command --log-dir /Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-27-15-09-56_p06-5/verifications/F-013/runtime-logs -- node scripts/run-tests.ts test/modules/onboarding/p06-5-f013-brownfield-integration.test.ts test/modules/acceptance/docs-p06-5-f013-report.test.ts
```

退出码：0。结果：2 个文件、5 项测试通过；完整日志：`verifications/F-013/runtime-logs/test-7ew5fh5_.log`。

本 Task Runtime 未运行 `npm run verify`、`npm test`、Phase acceptance 或全仓历史回归。类型、构建、工程 verify 和 Feature task_union 由独立 Nezha Verifier/阶段验收安排；未运行项是 `not_run`，不能从本文件的 3 项通过推出全 Feature 或 Phase 通过。

## 操作边界与限制

- `project init` 的注册确认与 `baseline run` 的基线确认是两个独立确认；预览、取消和响应中断不会隐式注册、执行或取消。
- CLI/Host 查询只使用结构化持久状态和受控制品引用；日志中出现成功文字不能替代 SQLite 行、Git 内容、进程状态或制品哈希。
- 测试 finally 只回收当前夹具创建的临时目录、Host、检查进程和移动路径；没有清理用户目录、开发仓库或其他项目。
- 本记录没有代签 Phase，也没有改变 Feature/Task 正式状态。真实模型、live 负责人确认和 P06-7 完整资源隔离演示保持独立门槛。
