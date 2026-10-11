# F-014 最终验证记录（脱敏副本）

- 用途：P02 阶段最终集成核验的命令/退出码、受测代码身份、证据完整性复验与临时
  进程/资源清理记录。只保存必要证据摘要，**不含真实 token、认证头、环境秘密或
  用户文件正文**（脱敏约定与 `accept:p02` 报告一致）。
- 身份分层（互不冒充）：
  - 产品代码受测 commit：`24b8377872f25c30e3a1efcc25504c9653c2b663`（F-014 回归修复）。
  - 文档/守护交付提交（本文件所在提交）：hash 由记录提交回填至下表，受测运行在该树
    （工作树 clean）执行。
  - 运行记录回填提交（其后）：仅回填本文件与两份报告的运行记录文本，**不改变产品代码**。
- 缺失/未运行项**不折算通过**：本记录只登记实际执行过的命令与真实退出码。

## 1. 命令与退出码（实际执行）

| 序 | 命令 | 形态/对象 | 退出码 | 耗时 | 输出证据 |
|---|---|---|---|---|---|
| 1 | `npm run verify` | 产品代码受测树（`24b8377…`，工作树 clean） | 0 | 约 110s | `tool-logs/F-014-r1-verify.log` |
| 2 | `npm run accept:p02` | 同上；深度 0 单命令 | （未完成，见 §2 说明） | 600s 预算截断 | `tool-logs/F-014-r1-accept-p02.log` |
| 3 | `npm run verify` | 文档/守护交付树（最终复跑） | （记录提交前回填） | （回填） | `tool-logs/F-014-r2-verify.log` |
| 4 | `npm run accept:p02` | 干净快照复跑 `accept-p02-1`（最终复跑） | （记录提交前回填） | （回填） | `docs/acceptance/evidence-p02-4-clean-replay/accept-runs/accept-p02-1/` |
| 5 | `npm run accept:p02` | 干净快照复跑 `accept-p02-2`（最终复跑） | （记录提交前回填） | （回填） | `docs/acceptance/evidence-p02-4-clean-replay/accept-runs/accept-p02-2/` |

- 序 1 逐项：`npm test` 116 files / 2961 tests 全过（0 skip/0 fail）、`npm run typecheck`
  退出 0、`npm run build`（含 dist 冒烟）退出 0；`verify: PASS 3/3 checks exited 0`。
- 序 2 说明（资源限制，如实记录、不冒充通过）：步骤 1-10 全部 EXIT 0（verify 93.3s、
  9 个场景步骤约 155s），步骤 11（`test/p02-4-clean-replay.test.ts` 完整复跑形态）进行中
  被本执行环境 600s 单命令预算截断；该控制器运行未产生最终报告，**不计入通过**。
  完整 `npm run accept:p02` exit 0 证据由序 4/5（操作指南 §4.4 分阶段复跑入口）提供。
- 序 4/5 的逐项计数均为 **pass 15 / fail 0 / not_run 0**，run-id/报告目录互相独立；
  机器可读报告在各 `accept-runs/` 目录内（report.json 的 `git.commit`/`stateDigests`/
  `evidence[]` 带 hash/size）。

## 2. 受测工作树状态（git status --porcelain）

- 序 1/2 执行时（产品代码受测树）：`git status --porcelain` 输出为空（clean），
  HEAD = `24b8377872f25c30e3a1efcc25504c9653c2b663`。
- 序 3/4/5 执行时（文档/守护交付树）：`git status --porcelain` 原文（记录提交前回填）；
  HEAD = 文档/守护交付提交（hash 记录提交前回填）。
- 复跑期间 `docs/acceptance/evidence-p02-4-clean-replay/` 由复跑工具按冻结输出目录
  重新生成（内容为最终代码的复跑证据；F-012 时代的同目录证据被该工具的正式输出
  取代，`outcome.json` 的 `commit` 字段记录实际快照 commit）。

## 3. 证据完整性复验（hash/size 逐项）

- `docs/acceptance/evidence-p02-4-clean-replay/outcome.json` 的 `evidence[]` 清单
  （path/sha256/sizeBytes）与磁盘文件逐项重验：结果（记录提交前回填）。
- `accept-runs/accept-p02-1` 与 `accept-runs/accept-p02-2` 的 report.json `evidence[]`
  hash/size 重验与两份运行互不覆盖核对：结果（记录提交前回填）。
- 本文件与两份报告的脱敏扫描（无 64hex 秘密/完整摘要、无 token/认证头取值、无环境
  秘密名、无开发机绝对路径、无用户文件正文）：结果（记录提交前回填）。

## 4. 临时进程与资源清理

- 复跑工具自带收尾核验：无自有 Host/基线进程残留、无锁/发现文件/哨兵继续写入残留、
  临时根已删除（见 `cleanup.json` 与 `outcome.json`）。
- F-014 运行前后进程清点（`ps` 过滤 `packages/host/dist/start.js`、`packages/cli/dist/bin.js`）：
  - 运行前发现的早前测试会话遗留 Host 孤儿进程（夹具数据根位于临时目录、非本会话
    启动）：清单与处置（记录提交前回填）——只终止进程，不改业务库、不删任何锁文件；
  - 截断运行（序 2）遗留子进程的回收：（记录提交前回填）;
  - 最终清点：无本次运行遗留进程/临时目录（记录提交前回填）。
- Harness 自身编排进程不属于本产品运行资源，不在清理范围，未做任何操作。

## 5. 边界声明

- **未运行真实 Pi**（未调用真实模型/Work）；**Windows / WSL / Linux 未验收**；
  **未验收强沙箱**；后序能力未实现。
- 必需检查非通过或未解决契约冲突时保留未完成状态：本记录与报告**不自动合并**、
  **不启动下一 Phase**、**不代替人工放行**；人工审阅清单 §8 签字前，P03 候选基线
  仅是候选。
