# P02-4 Feature 交付报告（F-014：P02 阶段最终集成核验与交付）

**放行更新（2026-10-11）**：负责人已接受 P02-3 §15 首版设计并明确 P02 验收通过，
允许进入 P03。最新受测提交 `ca63e21a6a5c4e86c170345476d7d62b131077ca`，
验收 `20261011T081336Z-caf6b072` 为 15/15，完整干净快照两次复跑通过。
人工结论见 `p02-4-review-checklist.md` §8。下文保留此前交付的历史事实，
“待负责人核对/未签字”和当时运行预算限制不再构成当前放行阻塞；范围边界仍有效。

- 验收日期：2026-10-11
- 验收平台：macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0）
- 工具版本：Node `22.19.0` / npm `10.9.3` / Git `2.50.1 (Apple Git-155)` / TypeScript `7.0.2`
  / Vitest `5.0.3` / better-sqlite3 `13.0.3` / drizzle-orm `0.45.3` / @types/node `22.20.4`
  （全部精确锁定）。
- 受测代码身份与报告提交区分：
  - **产品代码受测 commit**：`24b8377872f25c30e3a1efcc25504c9653c2b663`（F-014 必需行为
    回归修复提交；产品代码自 `948bbdf9610e641adde84a04df87ee5aace37dc1`（F-013）后的唯一
    变更）。
  - **文档/守护受测状态**：本报告、P02 阶段报告、脱敏验证记录与文档守护
    `test/docs-p02-4-f014-report.test.ts` 一并纳入最终验证（`npm run verify` 的
    npm test/typecheck/build 与 `npm run accept:p02` 复跑均在其后于该交付树执行，
    工作树状态逐次记录于 [verification-record](evidence-p02-4-final/verification-record.md)）。
  - **报告提交**：本文件与配套文档/证据作为 F-014 文档提交在其后进入版本库，
    **不改变产品代码**；受测 commit 与报告提交的完整身份、运行记录回填提交均在
    [verification-record](evidence-p02-4-final/verification-record.md) 中分层记录，
    不互相冒充。
- 范围界定：本报告是 **P02-4（P02 双客户端与初始化验收）**的 Feature 交付报告；
  P02 全阶段汇总见 [p02-stage-report.md](p02-stage-report.md)。结论均来自真实命令退出码
  与可核对证据；Nezha/Harness 的 `completed` 不替代代码验收，缺失与未运行项不折算通过。

## 1. 输入计划摘要

- PRD：`input/p02-acceptance.md` v0.2（2026-10-01，「待审阅的需求文档」），内容摘要
  `016888a6…76c0`（SHA-256，缩写展示）；共同执行约束 `input/execution-contract.md`
  （2026-10-01），内容摘要 `89dcd2b2…e069`。
- 需求 **FR-1 阶段闭环演示**（双 CLI 同数据根、唯一 Host、共享持久状态、获准基线、
  重启可查询、重复运行不依赖残留）与 **FR-2 负例与证据**（重复初始化/命令冲突、源文件
  保留、认证拒绝、客户端退出、基线失败、报告可验证）；验收标准 §3.3 共 5 条。
- 实施前置契约：[p02-4-acceptance-contract.md](../p02-4-acceptance-contract.md)
  （F-001 冻结：15 个稳定必需检查 ID、断言三轴、报告 Schema 与 fail-closed 聚合约定）。
- 机器可读必需检查清单：`acceptance/p02.config.json`（`configVersion: 1`）。

## 2. 实现范围（F-001 ~ F-014）

- **F-001**：核对 P01/P02-1/P02-2/P02-3 放行基线，冻结 P02 阶段验收清单与接口映射
  （纯文档 + 守护）。
- **F-002**：隔离夹具与证据快照（真实 dist CLI、临时 Git/SQLite/数据根、脱敏导出）。
- **F-003**：双 CLI 竞争启动与共享持久项目状态真实验收（`P02-FR1-UNIQUE-HOST`/
  `P02-FR1-SHARED-STATE`）。
- **F-004**：重复 init、同命令重放与参数冲突跨客户端验收（`P02-FR2-DUPLICATE-INIT`/
  `P02-FR2-COMMAND-CONFLICT`）。
- **F-005**：干净/脏仓库接入只读性与未知脚本零执行（`P02-FR2-SOURCE-PRESERVED`）。
- **F-006**：认证、协议、项目范围与固定回环监听负例（`P02-FR2-AUTH-REJECT`）。
- **F-007**：客户端退出与 Host 安全停止/重启闭环（`P02-FR2-CLIENT-EXIT`/
  `P02-FR1-RESTART-QUERY`）。
- **F-008**：基线失败、未授权与执行异常真实 CLI/Host 验收（`P02-FR2-BASELINE-FAILURE`）。
- **F-009**：版本化逐项报告、证据导出校验与 fail-closed 聚合（`P02-PHASE-NOT-RUN`/
  `P02-PHASE-REPORT`）。
- **F-010**：版本化 P02 验收配置、稳定场景清单与参数校验（必需检查不可被配置关闭）。
- **F-011**：`npm run accept:p02` 单次阶段控制器（工程验证 + 真实场景 + 报告 + 失败传播）。
- **F-012**：干净快照连续复跑（`P02-ENG-CLEAN-REPLAY`；npm ci/build → 导入/非源码 cwd
  冒烟 → 连续两次 `npm run accept:p02`）。
- **F-013**：P02 操作指南、验收复跑说明与人工审阅清单（文档 + 守护）。
- **F-014（本报告）**：阶段最终集成核验、必需行为缺陷回归修复、Feature/阶段交付报告、
  脱敏验证记录与最终逐项复验。

## 3. 本阶段最终集成核验发现并修复的必需行为缺陷

- 现象：`npm run verify` 的构建冒烟在 `shiploop-cli: events follow SIGINT` 断言上偶发
  失败（`must exit 4, got 3/null: shiploop: unreachable: 操作已被 AbortSignal 中止`）。
- 定位：SIGINT/Abort 落在事件订阅**建连窗口**（响应头未回）时，HostClient 以
  `unreachable(aborted)` 拒绝，`executeEventsCommand` 未把中止形态错误归入观察中断，
  被顶层误归类为连接失败（退出码 3），违反契约 §12.3 第五档（Ctrl+C 只结束本次观察）。
- 处置（严格 TDD）：先补确定性失败回归
  （`test/app-cli-events-scripted.test.ts`「建连等待事件流响应头期间 Abort」，可编排对端
  挂起建连 + AbortController，RED 复现 exit 3），再修复
  （`packages/cli/src/app-execute.ts` 增加中止形态错误识别，命中即返回
  `observation_interrupted`/退出码 4，含最后游标），复跑 GREEN（11/11）。
- 回归：事件/CLI 受影响组 250 tests 全过；`npm run build` 冒烟（含该断言）退出 0。
- 修复提交：`24b8377872f25c30e3a1efcc25504c9653c2b663`。该问题属本阶段必需行为
  （`P02-FR2-CLIENT-EXIT`/构建冒烟契约），按「先补失败回归再修复并复跑」闭环，
  未留待下一阶段、未降低任何门槛。

## 4. 验证命令、退出码与逐项计数

历史统计区分：首次产品代码验证为 116 files / 2961 tests；文档/守护回填后在
`e6a3a46239b35fb1f89684b374bf94a08737a500` 的最终验证为 117 files / 2970 tests。
以下保留首次记录；acceptance/p02 修复后的结果单独记录，不覆盖历史证据。

- `npm run verify`（锁文件预检 + `npm test` / `npm run typecheck` / `npm run build`）：
  **退出码 0**，3/3 步骤 EXIT 0；`npm test` 116 files / 2961 tests 全过（0 skip/0 fail）。
- `npm run accept:p02`：**退出码 0**，逐项计数 **pass 15 / fail 0 / not_run 0**；
  连续两次运行（干净快照复跑 `accept-p02-1`/`accept-p02-2`，run-id
  `20261011T060231Z-2a5ef158`、`20261011T060655Z-3737aea6`）均 exit 0 且 15/15，两次
  run-id/报告目录/临时资源独立。执行形态与运行记录（含 run-id、逐步耗时、工作树状态）
  见 [verification-record](evidence-p02-4-final/verification-record.md)：
  单次深度 0 `npm run accept:p02` 内含完整干净快照复跑（两次嵌套 `npm run accept:p02`），
  总时长约 13 分钟，超出本执行环境单命令 600s 预算，故按
  [p02-4-operations.md](../p02-4-operations.md) §4.4 的分阶段复跑入口
  （`--phase prepare | accept-1 | accept-2 | finalize`）顺序执行全部必需检查；各阶段
  实际执行的命令仍是 `npm run accept:p02` 本体（exit 0 证据逐份留存）。这是运行环境
  资源限制的如实记录，不是检查跳过，任何必需检查都没有被免跑或折算通过。
- 阶段必需检查逐项结果（15 项，与 `acceptance/p02.config.json` 一致）与负例核对矩阵见
  [p02-stage-report.md](p02-stage-report.md) §4/§5。

## 5. 代码/状态摘要

- 受测产品代码：`24b8377872f25c30e3a1efcc25504c9653c2b663`；前序文档基线
  `948bbdf9610e641adde84a04df87ee5aace37dc1`（F-013）；分支
  `feat/2026-10-04-23-19-52_p02-4-p02`。产品代码变更仅 `packages/cli/src/app-execute.ts`
  （观察中断归类修复）与回归测试 `test/app-cli-events-scripted.test.ts`。
- 工作树状态：每次验证运行前 `git status --porcelain` 原文记录于
  [verification-record](evidence-p02-4-final/verification-record.md)（最终验证在文档交付树
  上执行且状态为 clean；记录回填提交后仅增加运行记录文本）。
- 状态摘要：SQLite 迁移 v1-v5、settings schema v2、应用线消息 schemaVersion 3、事件封套
  schemaVersion 1；`accept:p02` 报告内 `stateDigests`（代码/持久状态摘要）随各次运行
  落盘于 `artifacts/acceptance/p02/<run-id>/report.json`。

## 6. 实际耗时与资源限制

- 实际耗时（本次实测，逐次记录于 verification-record）：`npm run verify` 约 110s
  （npm test 约 85s + typecheck <1s + build 约 8s）；`npm run accept:p02` 单次约 4-5 分钟
  （verify 步骤约 95s + 9 个真实场景步骤约 155s + clean-replay 护栏步骤）；干净快照
  连续复跑总时长约 11 分钟（npm ci 约 4s / build 约 10s / 两次 accept:p02）。
- 资源限制：验收配置有限预算 `timeouts`（verifyMs 600,000 / scenarioMs 1,200,000 /
  overallMs 7,200,000）；每步超时按进程组 SIGKILL 收尾。本执行环境单条命令 600s 预算
  限制记录于 §4。全程使用临时目录下临时 Git 仓库/SQLite 数据根/Host 进程，事务内无
  网络/模型等待，输出有界。

## 7. 证据路径

- 运行记录与最终逐项复验（脱敏）：
  [evidence-p02-4-final/verification-record.md](evidence-p02-4-final/verification-record.md)。
- 干净快照连续复跑证据（脱敏，hash/size 清单在内）：
  `docs/acceptance/evidence-p02-4-clean-replay/`（[evidence-p02-4-clean-replay/](evidence-p02-4-clean-replay/)，
  `outcome.json`、`accept-runs/`、`smoke.json`、`cleanup.json`、`build-scan.json`）。
- `accept:p02` 机器可读报告：`artifacts/acceptance/p02/<run-id>/`（report.json /
  summary.md / evidence/，运行环境内不入库，摘要与 run-id 见 verification-record）。
- 完整命令输出（Harness 工作区，不入库）：`tool-logs/F-014-*.log`。

## 8. 遗留问题（如实保留，不折算通过）

1. P02-3 契约 §15 的核对请求（inspect 身份范围、独立授权输入、状态映射、schemaVersion
   升 v3 等）保持**待负责人核对**，见 `p02-3-f020-report.md` §1。
2. 人工审阅清单（`p02-4-review-checklist.md` §8）**未签字**；放行由负责人执行，
   本交付不代替人工放行。
3. `stop_unconfirmed` 语义（不能重跑、不释放占用）为已知限制（操作指南 §5）。
4. 深度 0 单次 `npm run accept:p02` 的完整单命令运行受本执行环境 600s 预算限制，
   以 §4 记录的分阶段复跑完成同名命令的完整证据；如需单命令形态，请在无该预算限制
   的终端复跑（操作指南 §4.1/§4.4）。
5. 本报告运行期间发现的早前测试会话遗留 Host 孤儿进程的核对与回收记录见
   [verification-record](evidence-p02-4-final/verification-record.md)（仅动进程，
   不改任何业务库/锁文件）。

## 9. 范围边界（未做事项，明确不折算通过）

- **未运行真实 Pi**（未调用任何真实模型/Work 编排；验收用确定性 FakeRuntime/夹具）。
- **Windows / WSL / Linux 未验收**；仅 macOS 为正式验收平台。
- **未验收强沙箱**：首版为用户明确授权的可信项目模式，不具 OS 级强沙箱。
- 后序能力（托管 Chat、Web/Electron、NAS/云、rebind 等）未实现，不以占位接口宣称完成。
- 必需检查非通过或未解决契约冲突时保留未完成状态：本交付**不自动合并**、
  **不启动下一 Phase**、**不代替人工放行**。

## 10. P03 候选基线

- **P03 候选基线 = 本次运行记录回填提交**（本文件所在的最终提交；产品代码与受测提交
  `e6a3a46239b35fb1f89684b374bf94a08737a500`（文档/守护交付提交，工作树 clean）完全
  一致，差异仅文档/守护/证据/记录）。产品代码身份为
  `24b8377872f25c30e3a1efcc25504c9653c2b663`。候选基线可作为 P03 阶段的起点，
  **待人工审阅后放行**（提交 hash 由 `git log` 顶部 F-014 提交确定，见
  [verification-record](evidence-p02-4-final/verification-record.md)）。
