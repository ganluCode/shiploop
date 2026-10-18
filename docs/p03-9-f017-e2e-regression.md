# P03-9 / F-017 仅收尾重试 Host/CLI 端到端回归

日期：2026-10-18。状态：回归实现与聚焦验证已通过；Feature 全量验收仍由 Nezha 独立执行。

## 1. 覆盖范围

新测试 `test/p03-9-f017-finalization-host-vertical.test.ts` 使用真实临时 Git/SQLite/Artifact、真实 Host 和 `runAppCli → HostClient → Host → Core` 路径，检查执行使用确定性受信 Verifier（零模型、零真实凭据）。覆盖：

1. 最终检查失败后显式 `retryFinal`：新 Run 只执行最终检查，旧 Run 终态/Revision 不变，`workKey` 关联与 `dispatchOrdinal` 正确，Task/Attempt 历史保留，FakeRuntime 启动数不增加；第二次重试前会重新执行所需最终检查。
2. 仅提交失败、提交已发生但回执丢失：只继续缺失提交或先核对真实 Git 事实；不重复提交、不启动编码；最后核对 Feature/Run/Batch 完成状态与真实 commit 数。
3. 等待人审：批准命令只更新审批，不唤醒执行；显式 `execution.resume` 后才继续并完成。
4. 源码变化、检查定义变化、证据文件损坏：分别要求重新批准或重验相关 Task/最终检查，不沿用旧 `passed`，不创建编码 Attempt。
5. `maxRuns`、无进展上限、deadline、不可继续 Batch 拒绝；并发重复 `retryFinal` 只有一个成功，另一个明确拒绝；取消后不自动继续，计数不重置。
6. 所有场景断言 FakeRuntime `start` 次数为 0 增量、SQLite `runtime_starts` 不变、有效 Task 表内容不变。

## 2. 实现与修复

- `packages/core/src/application/work-scheduler.ts`：修复空扫描同步完成时 `scanPromise` 被外层赋值覆盖、后续扫描永久复用已结算 Promise 的问题；增加回归测试。
- `packages/core/src/application/finalization-execution.ts`：链式 `retryFinal` 的直接历史 Run 可能是无 Attempt 的 finalization Run；重验/最终检查沿 scope 回溯到真实代码 Run 绑定证据，同时保持 finalization Run 的调度身份。
- `packages/core/src/application/finalization-node-verifier.ts`：Task/Feature 检查批次绑定真实 Attempt 所属 Run（`FinalizationFeatureAnchor.runId`），满足 VerificationBatch 存储身份约束。
- `packages/core/src/application/finalization-completion.ts`：Git operation 归属真实 Attempt 的 Run，而不是可能为 finalization Run 的 `plan.historicalRunId`。
- `packages/host/src/runtime/host-startup.ts`：新增可信装配端口 `finalizationExecution`/`finalizationCompletion` 的启动传参；未装配时仍保留调度 capability gap。

## 3. 验证证据

- 聚焦回归：`test/p03-9-f017-finalization-host-vertical.test.ts`（10 项）、`test/p03-4-scheduler.test.ts`、`test/p03-9-f011-finalization-execution.test.ts`、`test/p03-9-f012-finalization-completion.test.ts`、`test/p03-9-f015-cli-control-vertical.test.ts` 共 36 项通过。
- 类型检查：`npm run typecheck` 退出码 0。
- 完整 stdout/stderr 与退出码保存在 Feature workspace 的 `verifications/F-017/runtime-logs/` 与 `tool-logs/f017-typecheck.log`。
- 脱敏回归证据摘要：`verifications/F-017/f017-e2e-evidence.json`。
- 回归选择清单：`verifications/F-017/test-selection.json`（未在本任务运行的文件交由 Nezha 独立复验）。

本文件不替代 P03-10 阶段验收脚本；不宣称 Feature 已全量验收。
