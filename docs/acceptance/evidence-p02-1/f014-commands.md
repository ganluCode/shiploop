# P02-1 F-014 文档核验命令记录（脱敏）

- 任务：F-014 完成 P02-1 操作说明、Feature 交付报告与后续 Host/CLI 接口交接。
- 受测代码 commit：`8473f306d8bc825356eaa42defc3e512e22edbae`（F-013 提交）；F-014 仅新增
  文档与文档守护测试，不改变受测产品代码。
- 平台：macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0）；Node `22.19.0` / npm `10.9.3` /
  TypeScript `7.0.2` / Vitest `5.0.3`。
- 本文档不记录开发机绝对路径与真实凭据；完整命令日志保存在 Harness Feature 工作区的
  `tool-logs/`（非仓库运行产物）。工作区/临时路径以 `<WORKSPACE-ROOT>` / `<TMPDIR>` 占位。

## 命令与退出码

| # | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `npm test` | 59 files / **1332 tests** 全绿（F-013 快照 58 / 1329，F-014 新增 1 file / 3 tests） | 0 |
| 2 | `npm run typecheck` | 无诊断 | 0 |
| 3 | `npm run check:boundaries` | 62 个生产 TS 文件、0 诊断（core 27 / host 28 / cli 7） | 0 |
| 4 | `npm run build` | 原生锁 + 三包 `tsc -b` + `prepare-cli-bin` + dist 冒烟全 0 | 0 |
| 5 | `npm run verify` | test/typecheck/build `PASS 3/3` | 0 |
| 6 | `npm test -- test/modules/host/docs-p02-1-operations.test.ts` | 3/3 通过（真实临时数据根 + 真实 Host 子进程纵向闭环） | 0 |

## 文档守护覆盖（`test/modules/host/docs-p02-1-operations.test.ts`）

- 操作说明 [p02-1-operations.md](../p02-1-operations.md) 的纵向命令在真实临时数据根上可复跑：
  `host start`（`started`）→ 二次 `host start`（`already_running`，同一 `hostInstanceId`）→
  `host status`（`ready`）→ `host stop`（证据 `processExit=confirmed` / `lock=acquirable` /
  `discovery=removed`，`writer.lock` 保留）→ 无实例 `status`（`host_not_found`，退出码 3）。
- 相对数据根与监听地址覆盖（`--bind 0.0.0.0`）在联网前以退出码 2 拒绝、零副作用。
- 文档记录的命令/参数/默认值/退出码/诊断码与真实解析面（`parseHostCliArgs` / `getHostCliHelp`）
  一致；文档不含 `project`/`run`/`feature` 等未提供命令。
- 交接文档与报告引用真实存在的契约/证据文件，明确 `项目注册` / `SSE` / `Scheduler` / `Runner` /
  `Pi SDK` / `command_receipts` / `accept:p02` / `not_run` 等未实现能力。
- 操作说明/交接文档/报告均不含开发机绝对路径或凭据样例，未出现 64 位
  hex 凭据样式字符串。

## 结论

`npm run verify`（`PASS 3/3`）与 `check:boundaries`（0 诊断）退出码均为 0；F-014 新增的文档
守护测试进入 `npm test` 默认收集且通过。本记录仅限 P02-1 Host 生命周期子集，不声称项目接入、
执行取消、SSE、Web 配对、跨平台或整个 P02 已验收。
