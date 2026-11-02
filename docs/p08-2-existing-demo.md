# P08-2 F-008 非 Nezha 存量仓库增量变更契约

`scripts/acceptance/p08-existing-demo.ts` 和 `test/helpers/p08-2/existing-repo-fixture.ts` 为 P08 存量项目演示保留局部契约与真实临时 Git 夹具。夹具不是产品实现，也不连接真实用户仓库、凭据、模型或 Harness 状态。

## 局部夹具覆盖

- 真实临时仓库先提交旧代码和两个已有测试，其中 `known-regression` 固定退出码 1，作为明确的未解决基线失败；另一个已有测试通过。
- 初始化前制造修改过的跟踪文件、暂存文件和未跟踪文件。`evaluateExistingRepoInitialization` 要求项目 ID、仓库路径摘要、批准路径和显式确认一致，并核对 HEAD、Git 脏状态均未改变，禁止自动提交。
- 增量只允许批准的相对路径，并分别登记 `code` 与 `test` 变更、验证命令/退出码/制品引用和 Git commit/tree。夹具用 `git add -- <approved paths>` 提交增量，原有脏文件保持在工作区。
- 报告类型固定为 `shiploop.existing-repo.incremental-evidence`，与 `shiploop.todo.live-evidence` 分开。报告将已有失败登记为 `known_failure` 和 `baselineGaps[].status=unresolved`，整体降为 `inconclusive`，不能靠新需求通过自动豁免。
- 报告不保存仓库绝对路径，只保存路径摘要和相对文件名；固定列出真实初始化、Pi 增量执行、Host/SQLite/进程组合以及归档重开为 `not_run`。

测试入口：

```sh
node scripts/run-tests.ts test/modules/acceptance/p08-2-f008-existing-demo.test.ts
```

该测试使用真实 Git 和系统临时目录，属于 integration；完整日志和退出码由 Harness `verifications/F-008/runtime-logs/` 保存。

## Phase 集成边界

本 Task 不把局部夹具检查当作产品接入验收。真实 `project init`、授权基线、SQLite 持久事实、Host/CLI、受管进程、真实 Pi、重复接入/归档/恢复和最终增量报告需要 P08 Phase 集成入口按真实临时资源执行。缺失或未执行项继续保持 `not_run`，已知失败必须在最终报告中作为未解决基线缺口展示。
