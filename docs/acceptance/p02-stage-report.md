# P02 阶段报告（本地 Host 与项目管理 CLI：阶段最终集成核验与交付）

- 报告日期：2026-10-11
- 验收平台：macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0）
- 工具版本：Node `22.19.0` / npm `10.9.3` / Git `2.50.1 (Apple Git-155)` / TypeScript `7.0.2`
  / Vitest `5.0.3` / better-sqlite3 `13.0.3` / drizzle-orm `0.45.3` / @types/node `22.20.4`。
- 受测代码身份与报告提交区分：产品代码受测 commit
  `24b8377872f25c30e3a1efcc25504c9653c2b663`（P02-4 F-014 必需行为回归修复）；本阶段报告
  与配套文档作为**报告提交**在其后入库，**不改变产品代码**；受测工作树状态、运行记录
  与回填提交的分层记录见
  [evidence-p02-4-final/verification-record.md](evidence-p02-4-final/verification-record.md)。
- 结论（基于真实命令退出码）：`npm run verify` **退出码 0**；`npm run accept:p02`
  **退出码 0**，逐项计数 **pass 15 / fail 0 / not_run 0**（连续两次运行一致）。
  人工审阅与放行**未完成**（见 §7）；Nezha `completed` 不替代代码验收，缺失/未运行项
  不折算通过。

## 1. 阶段构成与输入计划摘要

- P02 阶段由四个交付步骤组成（各步报告与契约互为输入）：
  | 步骤 | 范围 | 交付报告 | 实施契约 |
  |---|---|---|---|
  | P02-1 | Host 生命周期与写入者锁 | `p02-1-f014-report.md` | `p02-1-host-lifecycle-contract.md` |
  | P02-2 | 应用命令、查询与事件 | `p02-2-f020-report.md` | `p02-2-commands-events-contract.md` |
  | P02-3 | 项目初始化与获准基线检查 | `p02-3-f020-report.md` | `p02-3-onboarding-contract.md` |
  | P02-4 | P02 双客户端与初始化验收（阶段验收工程） | `p02-4-f014-report.md` | `p02-4-acceptance-contract.md` |
- P02-4 输入计划：PRD `input/p02-acceptance.md` v0.2（2026-10-01），内容摘要
  `016888a6…76c0`；共同执行约束 `input/execution-contract.md`，内容摘要 `89dcd2b2…e069`。
  需求 FR-1（阶段闭环演示）/FR-2（负例与证据）与验收标准 §3.3 五条为本阶段最终验收口径。
- P02-4 实现范围 F-001 ~ F-014：F-001 前序放行基线核验与清单冻结；F-002 隔离夹具与
  证据快照；F-003 双 CLI 竞争/共享状态；F-004 重复 init/命令重放/冲突；F-005 干净/脏
  仓库只读与未知脚本零执行；F-006 认证/协议/范围/监听负例；F-007 客户端退出与
  停止/重启闭环；F-008 基线失败/未授权/执行异常；F-009 版本化报告与 fail-closed 聚合；
  F-010 版本化验收配置；F-011 `npm run accept:p02` 控制器；F-012 干净快照连续复跑；
  F-013 操作指南/复跑说明/人工审阅清单；F-014（本报告）阶段最终集成核验与交付。
- 前序阶段基线：P01（`accept:p01`，14/14）已交付；P02-1/2/3 产品代码经各自集成回归
  并合入本分支，接口/Schema 契约沿用各实施契约，不在此重定义。

## 2. 实测命令、退出码与状态摘要

历史统计区分：首次产品代码验证为 116 files / 2961 tests；文档/守护回填后在
`e6a3a46239b35fb1f89684b374bf94a08737a500` 的最终验证为 117 files / 2970 tests。
下表保留首次记录，不把不同受测提交的统计混成一次运行。本次 acceptance/p02
修复后的结果另见 `p02-manual-acceptance.md`，不覆盖历史证据。

| 命令 | 形态 | 退出码 | 计数/结论 | 证据 |
|---|---|---|---|---|
| `npm run verify` | 直接运行（受测树） | 0 | npm test 116 files / 2961 tests 全过、typecheck 0、build+dist 冒烟 0 | `tool-logs/F-014-*.log`、verification-record |
| `npm run accept:p02`（第 1 次） | 干净快照复跑 `accept-p02-1`（run-id `20261011T060231Z-2a5ef158`） | 0 | pass 15 / fail 0 / not_run 0 | `docs/acceptance/evidence-p02-4-clean-replay/accept-runs/accept-p02-1/` |
| `npm run accept:p02`（第 2 次） | 干净快照复跑 `accept-p02-2`（run-id `20261011T060655Z-3737aea6`） | 0 | pass 15 / fail 0 / not_run 0 | `docs/acceptance/evidence-p02-4-clean-replay/accept-runs/accept-p02-2/` |

- 状态摘要：SQLite 迁移 v1-v5、settings schema v2、应用线消息 schemaVersion 3、事件封套
  schemaVersion 1；单 Host/单写者（`host/writer.lock`）不变量、命令幂等回执与基线四表
  持久状态均经真实 CLI/Host/SQLite 断言。运行工作树状态（`git status --porcelain`）与
  逐次 run-id 见 [verification-record](evidence-p02-4-final/verification-record.md)。
- 执行形态说明（资源限制，如实记录）：单次深度 0 `npm run accept:p02` 含完整干净快照
  复跑（两次嵌套 `npm run accept:p02`），总时长约 13 分钟，超出本执行环境单命令 600s
  预算；按 `p02-4-operations.md` §4.4 分阶段复跑入口顺序执行，各阶段实际命令仍是
  `npm run accept:p02` 本体并逐份留存 exit 0 证据。没有跳过任何必需检查，未运行项
  不折算通过。

## 3. 本阶段最终核验发现并修复的必需行为缺陷

- 构建冒烟 `events follow SIGINT must exit 4` 偶发失败（exit 3 `unreachable`）：SIGINT
  落在事件订阅建连窗口时，中止形态错误被误归类为连接失败。按 TDD 先补确定性失败回归
  （`test/app-cli-events-scripted.test.ts`），再修复 `packages/cli/src/app-execute.ts`
  的观察中断归类（exit 4 + `observation_interrupted`，含最后游标），回归组 250 tests
  与构建冒烟复跑全过。修复提交 `24b8377872f25c30e3a1efcc25504c9653c2b663`。
  属 `P02-FR2-CLIENT-EXIT` 必需行为，先补失败回归再修复并复跑，未留待下一阶段、
  未降低门槛。

## 4. 必需检查逐项结果（15 项，与 `acceptance/p02.config.json` 一致）

| 检查 ID | 承接分支 | 实际测试/命令入口 | 结果 | 证据要点 |
|---|---|---|---|---|
| `P02-ENG-VERIFY` | 工程 | `npm run verify` | pass | 3/3 步骤 exit 0；116 files / 2961 tests |
| `P02-FR1-UNIQUE-HOST` | FR-1 唯一 Host | `test/p02-4-dual-cli-acceptance.test.ts` | pass | 双 dist CLI 竞争同数据根、唯一 hostInstanceId、127.0.0.1 |
| `P02-FR1-SHARED-STATE` | FR-1 共享项目/配置 | `test/p02-4-dual-cli-acceptance.test.ts` | pass | 双客户端 projectId/revision/来源逐字段一致 |
| `P02-FR1-BASELINE-OK` | FR-1 授权基线 | `test/p02-4-dual-cli-acceptance.test.ts` | pass | 同 operationId、逐项检查、制品 hash/size |
| `P02-FR2-DUPLICATE-INIT` | FR-2 重复初始化 | `test/p02-4-idempotency-acceptance.test.ts` | pass | 见 §5 负例矩阵 |
| `P02-FR2-COMMAND-CONFLICT` | FR-2 命令重放/冲突 | `test/p02-4-idempotency-acceptance.test.ts` | pass | 见 §5 负例矩阵 |
| `P02-FR2-SOURCE-PRESERVED` | FR-2 源文件保留 | `test/p02-4-repo-preservation-acceptance.test.ts` | pass | 见 §5 负例矩阵 |
| `P02-FR2-AUTH-REJECT` | FR-2 认证拒绝 | `test/p02-4-negative-acceptance.test.ts` | pass | 见 §5 负例矩阵 |
| `P02-FR2-CLIENT-EXIT` | FR-2 客户端退出 | `test/p02-4-restart-acceptance.test.ts` | pass | 见 §5 负例矩阵 |
| `P02-FR1-RESTART-QUERY` | FR-1 重启查询 | `test/p02-4-restart-acceptance.test.ts` | pass | 重启后 projectId/配置/结果/制品 hash/size 一致、旧凭据被拒 |
| `P02-FR2-BASELINE-FAILURE` | FR-2 基线失败 | `test/p02-4-baseline-failure-acceptance.test.ts` | pass | 见 §5 负例矩阵 |
| `P02-PHASE-FIXTURE` | 夹具失败 | `test/p02-4-acceptance-controller.test.ts` | pass | 夹具失败明确 fail/not_run、证据保留、进程回收 |
| `P02-PHASE-NOT-RUN` | 必需检查未运行 | `test/p02-4-report-aggregation.test.ts` | pass | 未提交/超时/跳过 → not_run，不聚合为通过 |
| `P02-PHASE-REPORT` | 报告完整性 | `test/p02-4-acceptance-report.test.ts` | pass | Schema v1、逐项结果、证据 hash/size、脱敏、结论重算 |
| `P02-ENG-CLEAN-REPLAY` | 重复运行不依赖残留 | `test/p02-4-clean-replay.test.ts` | pass | 干净快照连续两次 `npm run accept:p02` exit 0、运行独立、无残留 |

逐项计数：**pass 15 / fail 0 / not_run 0**（两次运行一致；`artifacts/acceptance/p02/<run-id>/report.json` 为机器可读同源记录）。

## 5. 负例核对矩阵（拒绝/错误 · 状态 · 意外副作用）

| 检查 ID | 负例场景 | 拒绝/错误断言 | 状态断言 | 意外副作用核对 |
|---|---|---|---|---|
| `P02-FR2-DUPLICATE-INIT` | 重复 init（同规范路径/别名） | 拒绝重复新增：返回 `already_registered`、`projectId` 不变 ✔ | 持久状态：项目/绑定各一份，原名称/描述/标签/配置逐字段保持 ✔ | 元数据快照前后一致，无新增行、无覆盖写 ✔ |
| `P02-FR2-COMMAND-CONFLICT` | 同 commandId 重放 / 异参数冲突 | 拒绝：同 ID 异摘要 → `conflict`（`idempotency_key_reuse`）✔；重放返回原回执（`replayed: true`）✔ | 持久状态：原回执仍可查、无额外变更 ✔ | 零副作用：命令零重复启动、结果身份不变 ✔ |
| `P02-FR2-SOURCE-PRESERVED` | 干净/脏仓库只读接入、恶意初始化脚本 | 拒绝：未经单独授权的 init/overview 不执行脚本（哨兵零写入）✔ | 持久状态：HEAD/索引/Git 状态/文件字节摘要前后逐项一致 ✔ | 零副作用：无依赖安装产物、AGENTS.md/README.md 字节不变 ✔ |
| `P02-FR2-AUTH-REJECT` | 认证/协议/项目范围/监听覆盖拒绝 | 拒绝：`unauthorized`/`protocol_incompatible`/`unsupported_schema_version`/`invalid_input`/`forbidden` 明确错误码 ✔ | 持久状态：无注册/基线/配置行新增，原状态不变 ✔ | 零副作用：零写请求生效、仅绑定 127.0.0.1、脱敏扫描零命中 ✔ |
| `P02-FR2-CLIENT-EXIT` | 观察中断/客户端退出（含建连窗口） | 错误断言：终态记录 `observation_interrupted`、退出码 4（F-014 修复后建连窗口同样成立）✔ | 持久状态：Host 存活、不发 stop/cancel、已提交命令不受影响 ✔ | 另一 CLI 仍可认证查询同一 Host，无意外状态变化 ✔ |
| `P02-FR2-BASELINE-FAILURE` | 非零退出/拒绝授权/缺命令/未知脚本/超时/取消/停止未确认 | 拒绝：固定非零退出与 `not_run`（`authorization_rejected`）如实记录、不冒充通过 ✔ | 持久状态：失败不撤销注册、失败证据不删 ✔ | 零副作用：拒绝授权与未启动检查零启动（哨兵零执行）✔ |

- 负例只有在错误断言与副作用断言同时成立时才计 pass；矩阵各列核对落到实际测试断言
  （契约断言三轴 error/zeroStart/persistentState）与 `report.json` 的
  `errorAssertion`/`zeroStartAssertion`/`persistentStateAssertion` 字段。

## 6. 实际耗时、资源限制与证据路径

- 实际耗时：`npm run verify` 约 110s；`npm run accept:p02` 单次约 4-5 分钟（verify 步骤
  约 95s、9 个真实场景步骤约 155s、clean-replay 护栏步骤）；干净快照连续复跑总时长约
  11 分钟（npm ci 约 4s、build 约 10s、两次 accept:p02）；深度 0 单次完整运行约 13 分钟
  （受 600s 单命令预算限制，见 §2）。
- 资源限制：`timeouts` verifyMs 600,000 / scenarioMs 1,200,000 / overallMs 7,200,000；
  输出有界（`maxCommandOutputBytes`）；全程临时 Git 仓库/SQLite 数据根/Host 进程，
  不触碰用户仓库与真实凭据。
- 证据路径：
  - [evidence-p02-4-final/verification-record.md](evidence-p02-4-final/verification-record.md)
    ——命令/退出码、受测 commit 与工作树状态、证据 hash/size 复验、临时进程/资源清理、
    脱敏扫描；
  - [evidence-p02-4-clean-replay/](evidence-p02-4-clean-replay/)——干净快照连续复跑
    证据（`outcome.json`/`accept-runs/`/`smoke.json`/`cleanup.json`/`build-scan.json`）；
  - `artifacts/acceptance/p02/<run-id>/`——`accept:p02` 机器可读报告（report.json /
    summary.md / evidence/，运行环境内）；
  - `tool-logs/F-014-*.log`——完整命令输出（Harness 工作区）。

## 7. 遗留问题与放行状态

1. P02-3 契约 §15 核对请求保持待负责人核对（详见 `p02-3-f020-report.md` §1）。
2. 人工审阅清单（`p02-4-review-checklist.md` §8）未签字：**人工未审阅 = 未完成**；
   本交付**不代替人工放行**、**不自动合并**、**不启动下一 Phase**。
3. `stop_unconfirmed`（不能重跑、不释放占用）为已知限制（操作指南 §5）。
4. 深度 0 单次 `npm run accept:p02` 的单命令运行受执行环境 600s 预算限制（§2 记录）。
5. 早前测试会话遗留 Host 孤儿进程的核对/回收记录见 verification-record（只动进程，
   不改业务库、不删任何锁）。

## 8. 范围边界

- **未运行真实 Pi**（无真实模型/Work 调用；验收用确定性夹具）。
- **Windows / WSL / Linux 未验收**（仅 macOS 正式验收）。
- **未验收强沙箱**（可信项目模式，无 OS 级强沙箱）。
- 托管 Chat、Web/Electron、NAS/云与 rebind 等后序能力未实现，不以占位接口宣称完成。
- 任何必需检查非通过或未解决契约冲突都保留未完成状态，不自动合并、不启动下一 Phase、
  不代替人工放行。

## 9. P03 候选基线

- **P03 候选基线 = 本次运行记录回填提交**（本报告所在的最终提交；产品代码与受测提交
  `e6a3a46239b35fb1f89684b374bf94a08737a500`（文档/守护交付提交）完全一致，产品代码
  身份 `24b8377872f25c30e3a1efcc25504c9653c2b663`）。待负责人按人工审阅清单核对后放行
  进入 P03（提交 hash 由 `git log` 顶部 F-014 提交确定，见
  [verification-record](evidence-p02-4-final/verification-record.md)）。
