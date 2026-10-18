# F-014 最终验证记录（脱敏副本）

- 用途：P02 阶段最终集成核验的命令/退出码、受测代码身份、证据完整性复验与临时
  进程/资源清理记录。只保存必要证据摘要，**不含真实 token、认证头、环境秘密或
  用户文件正文**（脱敏约定与 `accept:p02` 报告一致）。
- 身份分层（互不冒充）：
  - 产品代码受测 commit：`24b8377872f25c30e3a1efcc25504c9653c2b663`（F-014 回归修复）。
  - 文档/守护交付提交（本文件所在提交）：hash 由记录提交回填至下表，受测运行在该树
    （工作树 clean）执行。
  - 运行记录回填提交（其后）：仅回填本文件与两份报告的运行记录文本，**不改变产品代码**。
    P03 候选基线即该最终提交（产品代码与受测提交 `e6a3a46239b35fb1f89684b374bf94a08737a500`
    完全一致）；其 hash 由 `git log` 顶部 F-014 提交确定。
- 缺失/未运行项**不折算通过**：本记录只登记实际执行过的命令与真实退出码。

## 1. 命令与退出码（实际执行）

| 序 | 命令 | 形态/对象 | 退出码 | 耗时 | 输出证据 |
|---|---|---|---|---|---|
| 1 | `npm run verify` | 产品代码受测树（`24b8377…`，工作树 clean） | 0 | 约 110s | `tool-logs/F-014-r1-verify.log` |
| 2 | `npm run accept:p02` | 同上；深度 0 单命令 | （未完成，见 §2 说明） | 600s 预算截断 | `tool-logs/F-014-r1-accept-p02.log` |
| 3 | `npm run verify` | 文档/守护交付树（`e6a3a46239b35fb1f89684b374bf94a08737a500`，工作树 clean） | 0 | 90.5s（test 81.9s + typecheck 0.6s + build 8.0s） | `tool-logs/F-014-r2-verify.log` |
| 4 | `npm run accept:p02` | 干净快照复跑 `accept-p02-1`（run-id `20261011T060231Z-2a5ef158`） | 0 | 249.7s | `docs/acceptance/evidence-p02-4-clean-replay/accept-runs/accept-p02-1/` |
| 5 | `npm run accept:p02` | 干净快照复跑 `accept-p02-2`（run-id `20261011T060655Z-3737aea6`） | 0 | 247.2s | `docs/acceptance/evidence-p02-4-clean-replay/accept-runs/accept-p02-2/` |

- 序 1 逐项：`npm test` 116 files / 2961 tests 全过（0 skip/0 fail）、`npm run typecheck`
  退出 0、`npm run build`（含 dist 冒烟）退出 0；`verify: PASS 3/3 checks exited 0`。
- 序 2 说明（资源限制，如实记录、不冒充通过）：步骤 1-10 全部 EXIT 0（verify 93.3s、
  9 个场景步骤约 155s），步骤 11（`test/modules/acceptance/p02-4-clean-replay.test.ts` 完整复跑形态）进行中
  被本执行环境 600s 单命令预算截断；该控制器运行未产生最终报告，**不计入通过**。
  完整 `npm run accept:p02` exit 0 证据由序 4/5（操作指南 §4.4 分阶段复跑入口）提供。
- 序 4/5 的逐项计数均为 **pass 15 / fail 0 / not_run 0**（实测确认），run-id/报告目录互相独立；
  机器可读报告在各 `accept-runs/` 目录内（report.json 的 `git.commit`/`stateDigests`/
  `evidence[]` 带 hash/size）。

## 2. 受测工作树状态（git status --porcelain）

- 序 1/2 执行时（产品代码受测树）：`git status --porcelain` 输出为空（clean），
  HEAD = `24b8377872f25c30e3a1efcc25504c9653c2b663`。
- 序 3/4/5 执行时（文档/守护交付树）：`git status --porcelain` 输出为空（clean）；
  HEAD = `e6a3a46239b35fb1f89684b374bf94a08737a500`（文档/守护交付提交；含报告、守护、
  脱敏记录与恢复至 F-012 基线的复跑证据目录）。复跑快照 commit 同为
  `e6a3a46239b35fb1f89684b374bf94a08737a500`（outcome.json `commit` 字段）。
- 复跑期间 `docs/acceptance/evidence-p02-4-clean-replay/` 由复跑工具按冻结输出目录
  重新生成（内容为最终代码的复跑证据；F-012 时代的同目录证据被该工具的正式输出
  取代，`outcome.json` 的 `commit` 字段记录实际快照 commit）。

## 3. 证据完整性复验（hash/size 逐项）

- 复跑工具 finalize 在删除临时根前完成证据导出与 hash/size 复验（`PASS commit=e6a3a46…
  steps=6 runs=2 problems=0`，`tool-logs/F-014-replay-finalize.log`）；原始 evidence/ 副本
  按设计随临时快照删除，仓库内保留脱敏摘要。
- 持久副本逐项复验（`tool-logs/F-014-evidence-recheck.log`）：两次运行各 28 项
  `evidence-digests.json`（path/sha256/sizeBytes）与 `report.json` `evidence[]` 逐项一致；
  计数重算与 `counts`/`conclusion` 一致；`checks[].evidenceRefs` 无悬空引用；
  `outcome.json` ↔ `report.json` ↔ `summary.md` 交叉一致（runId/计数/结论）；
  两次 run-id 独立、报告目录互不覆盖。**零不一致**。
- 本文件与两份报告的脱敏扫描（无 64hex 秘密/完整摘要、无 token/认证头取值、无环境
  秘密名、无开发机绝对路径、无用户文件正文）：**零命中**（文档守护
  `test/modules/acceptance/docs-p02-4-f014-report.test.ts` 复跑通过，`tool-logs/F-014-final-guard.log`）。

## 4. 临时进程与资源清理

- 复跑工具自带收尾核验：无自有 Host/基线进程残留、无锁/发现文件/哨兵继续写入残留、
  临时根已删除（见 `cleanup.json` 与 `outcome.json`）。
- F-014 运行前后进程清点（`ps` 过滤 `packages/host/dist/start.js`、`packages/cli/dist/bin.js`）：
  - 清理前清点：**61 个**孤儿 Host 进程（含本 feature 早前任务/会话的夹具遗留、本次
    截断运行（序 2）遗留，以及历次测试夹具未回收的 `shiploop-f016-dist-*` 等）与
    **778 个**夹具临时目录；清单原文见 `tool-logs/F-014-cleanup.log`；
  - 处置：仅终止上述测试夹具进程（`pkill` + 对 1 个未响应进程显式 SIGKILL）并删除
    临时目录 `shiploop-*`；**未触碰** Harness/编排进程，未修改任何业务库、未删除任何锁；
  - 最终清点：**0 个**存活夹具进程、**0 个**残留夹具临时目录（同日志 FINAL SCAN）。
- Harness 自身编排进程不属于本产品运行资源，不在清理范围，未做任何操作。

## 5. 边界声明

- **未运行真实 Pi**（未调用真实模型/Work）；**Windows / WSL / Linux 未验收**；
  **未验收强沙箱**；后序能力未实现。
- 必需检查非通过或未解决契约冲突时保留未完成状态：本记录与报告**不自动合并**、
  **不启动下一 Phase**、**不代替人工放行**；人工审阅清单 §8 签字前，P03 候选基线
  仅是候选。
