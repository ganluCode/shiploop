# P01-4 Feature 验收报告（F-010：P01 持久化闭环阶段交付）

- 验收日期：2026-10-03
- 验收平台：macOS（Darwin 25.6.0 / arm64），Node `22.19.0` / npm `10.9.3` / SQLite `3.53.4` /
  better-sqlite3 `13.0.3` / drizzle-orm `0.45.3` / Git `2.50.1 (Apple Git-155)` / Vitest `5.0.3`
- 受测代码 commit：`815e9e6f3e6bb2387c2d0d949a17ffd6fb33d1dd`（分支
  `feat/2026-10-01-23-44-21_p01-4-p01`，工作树 `clean`）
- 阶段范围：P01 持久化闭环（FR-1 项目身份、FR-2 当前配置与制品、关闭重开逐字段一致），
  macOS 为唯一正式验收平台。
- 结论：**P01 阶段验收通过**——干净安装复跑七条命令真实退出码均为 0，连续两次
  `npm run accept:p01` 结论均为 `pass`（`pass 14 / fail 0 / not_run 0`），证据先落盘后清理临时资源。
- 本报告与配套文档在受测 commit 之后作为**文档/证据提交**加入，不改变受测代码；证据见
  [`evidence-p01-4/`](evidence-p01-4/)（已脱敏）。

## 1. 输入文档版本

设计输入为 Harness 知识目录 `architecture-redesign/`（不在本仓库，以内容哈希固化版本），
PRD 为 `p01-acceptance.md`（版本 0.2，2026-10-01）。本阶段实际依据的主要文档 SHA-256：

| 文档 | SHA-256 |
|---|---|
| `08-migration-roadmap.md` | `c6f527bd0846e805189b6ea8369cedb90442f6254198a3216dc3600c3d9c04a6` |
| `core-design/01-system-structure.md` | `1f66552a4e7e7b83c81f33138fbe81d5d9e4e5d9cb6ae5b69b92766e143c7490` |
| `core-design/02-domain-and-lifecycle.md` | `6fabe0e602e2e22667a9cf3e37c0b9b85049e96a1b51d7cf4876e18096f65f99` |
| `core-design/03-storage-and-transactions.md` | `c393f95c96d62c9ec708e3043fde78194c85acea2ea1dad6924b31fd83f7183d` |
| `core-design/06-project-and-context.md` | `ea9ef3e50e9f9ea5423ca673e41f6d3397996fd774c543b268316397d00c1394` |
| `core-design/07-verification-and-delivery.md` | `0bad1d917e9148d587924dfdd6c1901dd8cce6df159fe7a0a2c408c9ae3c11da` |
| `core-design/11-database-model.md` | `57dc3c6eab520fea43b5078a131821525f5c85336c09990719f10f9b705e5fa9` |
| `core-design/09-testing-and-implementation.md` | `69912f251a79be62617f80786a5e73e4db90d674977a32fad90282e8b4a213ad` |

前置契约：[docs/p01-4-acceptance-contract.md](../p01-4-acceptance-contract.md)（检查清单与报告约定）；
操作说明：[docs/p01-4-operations.md](../p01-4-operations.md)。

前序基线（均为当前分支祖先，实际端口与测试在库）：

| 阶段 | 分支 | tip commit | 已验收报告 |
|---|---|---|---|
| p01-engineering（P01-1） | `feat/2026-10-01-23-44-21_p01-1` | `44c8c30997c46b55d514bc429fcaf9337d755484` | `docs/acceptance/p01-1-f006-report.md` |
| p01-state-artifacts（P01-2） | `feat/2026-10-01-23-44-21_p01-2-sqlite` | `74934acba07f6a33c9957ec66ad2ccec2606f828` | `docs/acceptance/p01-2-f014-report.md` |
| p01-project-config（P01-3） | `feat/2026-10-01-23-44-21_p01-3` | `2578a66e28f49155fabdd5935bc228b9702459b5` | `docs/acceptance/p01-3-f014-report.md` |

## 2. 实现范围（F-001 ~ F-010）

- **F-001**：核验 P01-1/P01-2/P01-3 已验收基线与真实端口；冻结 14 个稳定必需检查 ID、FR 分支
  映射、报告位置/`run-id`/超时/三态与脱敏规则（[p01-4-acceptance-contract.md](../p01-4-acceptance-contract.md)）。
- **F-002**：真实临时 Git 仓库 / 隔离 `home` / 受控数据根夹具，固定配置与制品字节，
  安全清理守卫与清理前证据导出（`test/helpers/p01-4-fixture.ts`、`safe-cleanup.ts`）。
- **F-003**：经真实装配入口的持久化闭环（注册 → 全局/项目配置 → 制品发布 → 关闭重开逐字段一致）。
- **F-004**：真实 SQLite 回滚与当前配置 CAS 负例（组合创建注入回滚、脱敏审计注入回滚、
  跨进程同一旧 `revision` 竞争恰一胜者）。
- **F-005**：制品缺失/篡改负例与发布中断核对（`missing`/`corrupt` 诊断、`pending` 仅 hash/size
  匹配补 `ready`、孤儿 `kept_in_place`）。
- **F-006**：当前配置完整策略覆盖/来源/非法输入拒绝与项目标签规范化/筛选/计数阶段检查组。
- **F-007**：版本化 `report.json`/`summary.md` 与严格聚合器（三态、负例双断言、未知/重复 ID 拒绝）。
- **F-008**：`npm run accept:p01` 单次验收入口（`verify` + 四个固定场景 + 构建冒烟，有界子进程、
  fail-fast、失败/超时/启动失败显式分类）。
- **F-009**：构建产物非源码 cwd 冒烟与开发路径检查（个人绝对路径/被禁依赖/缺失迁移资源 fail-closed）。
- **F-010**（本报告）：干净安装复跑脚本 `scripts/acceptance/clean-snapshot-replay.ts`、
  P01 操作说明与交付报告、脱敏证据，并修复干净快照下暴露的前序夹具测试回归（§7）。

## 3. 环境与工具

| 项 | 值 |
|---|---|
| 平台 | macOS（Darwin 25.6.0 / arm64） |
| Node.js | `22.19.0` |
| npm | `10.9.3` |
| SQLite（驱动查询） | `3.53.4` |
| better-sqlite3 | `13.0.3` |
| drizzle-orm | `0.45.3` |
| Git | `2.50.1 (Apple Git-155)` |
| 测试运行器 | Vitest `5.0.3` |
| 依赖安装 | `npm ci`：added 47 packages，0 vulnerabilities |

环境/命令事实：[`evidence-p01-4/environment.json`](evidence-p01-4/environment.json) /
[`evidence-p01-4/commands.json`](evidence-p01-4/commands.json)。

## 4. 干净安装复跑（受测 commit `815e9e6`）

快照由 `git clone --no-hardlinks` 到系统临时目录并 `checkout --detach 815e9e6` 得到（含 `.git`，
使 `accept:p01` 能采集 commit/工作树事实），断言无 `node_modules` / `dist` 残留；依赖由
`npm ci` 按 `package-lock.json`（lockfileVersion 3）重建。命令、退出码、耗时记于
[`evidence-p01-4/commands.json`](evidence-p01-4/commands.json)，逐条日志见
[`evidence-p01-4/logs/`](evidence-p01-4/logs/)。

| # | 命令 | 退出码 | 耗时 | 证据 |
|---|---|---|---|---|
| 1 | `npm ci` | 0 | 2.7s | [npm-ci.log](evidence-p01-4/logs/npm-ci.log) |
| 2 | `npm test` | 0（45 files / 792 tests，无 skip） | 9.0s | [npm-test.log](evidence-p01-4/logs/npm-test.log) |
| 3 | `npm run typecheck` | 0 | 0.6s | [typecheck.log](evidence-p01-4/logs/typecheck.log) |
| 4 | `npm run build` | 0（三入口加载 + dist `./assembly` 冒烟） | 0.5s | [build.log](evidence-p01-4/logs/build.log) |
| 5 | `npm run verify` | 0（`PASS 3/3`） | 7.3s | [verify.log](evidence-p01-4/logs/verify.log) |
| 6 | `npm run accept:p01`（第 1 次） | 0（`pass 14 / fail 0 / not_run 0`） | 14.4s | [accept-1.log](evidence-p01-4/logs/accept-1.log) / [report.json](evidence-p01-4/accept-runs/accept-1/report.json) / [summary.md](evidence-p01-4/accept-runs/accept-1/summary.md) |
| 7 | `npm run accept:p01`（第 2 次，验证无残留依赖） | 0（`pass 14 / fail 0 / not_run 0`） | 14.5s | [accept-2.log](evidence-p01-4/logs/accept-2.log) / [report.json](evidence-p01-4/accept-runs/accept-2/report.json) / [summary.md](evidence-p01-4/accept-runs/accept-2/summary.md) |

两次 `accept:p01` 独立生成报告目录（源快照 `artifacts/acceptance/p01/<run-id>/`，脱敏副本固定
落于本仓库 `evidence-p01-4/accept-runs/accept-1|2/`）：

| 运行 | run-id | 报告位置（逻辑） | 结论 | 计数 |
|---|---|---|---|---|
| 第 1 次 | `20261002T230202Z-1d56aa56` | `<SNAPSHOT-ROOT>/artifacts/acceptance/p01/20261002T230202Z-1d56aa56/` | `pass` | 14 / 0 / 0 |
| 第 2 次 | `20261002T230217Z-19e2b169` | `<SNAPSHOT-ROOT>/artifacts/acceptance/p01/20261002T230217Z-19e2b169/` | `pass` | 14 / 0 / 0 |

两次报告均记录受测 commit `815e9e6…`、工作树 `clean`、平台与工具版本、前序基线、逐项检查、
证据 `sha256`/`sizeBytes` 与已知限制；连续第二次运行未依赖第一次的任何残留（无重装、无清理后
仍可复跑）。

受测 commit 的干净快照为 **45 files / 792 tests**；本报告与报告守护用例作为文档/证据提交加入后，
工作区回归为 **45 files / 796 tests**、`npm run verify` 仍 `PASS 3/3`（均无 skip）。

## 5. 阶段必需检查与 FR 分支映射

`accept:p01` 聚合 14 项必需检查，结论 `pass`（`pass 14 / fail 0 / not_run 0`）。逐项证据（重开、
回滚、制品缺失/恢复三类包含其中）见两次 accept 报告的 `evidence/checks/*.json` 与
`evidence/commands/*.log`：

| 检查 ID | 分支 | 结果 | 承接测试 / 命令入口 |
|---|---|---|---|
| `P01-ENG-VERIFY` | 工程 | pass | `npm run verify`（test / typecheck / build） |
| `P01-FR1-NORMAL` | FR-1 正常 | pass | `test/p01-4-persistence-closed-loop.test.ts` |
| `P01-FR1-REOPEN` | FR-1 重开 | pass | 同上 |
| `P01-FR1-ROLLBACK` | FR-1 回滚（负例） | pass | `test/p01-4-sqlite-rollback-and-cas.test.ts` |
| `P01-FR2-CONFIG` | FR-2 正常/拒绝（负例） | pass | `test/p01-4-config-and-tags.test.ts` |
| `P01-FR2-ROLLBACK` | FR-2 回滚（负例） | pass | `test/p01-4-sqlite-rollback-and-cas.test.ts` |
| `P01-FR2-CAS` | FR-2 CAS 竞争 | pass | 同上 |
| `P01-FR2-TAGS` | T32 项目标签 | pass | `test/p01-4-config-and-tags.test.ts` |
| `P01-FR2-ARTIFACT-MISSING` | FR-2 制品缺失（负例） | pass | `test/p01-4-artifact-negative.test.ts` |
| `P01-FR2-ARTIFACT-RECOVERY` | FR-2 制品恢复 | pass | 同上 |
| `P01-PHASE-FIXTURE` | 夹具失败 | pass | `test/p01-4-acceptance-controller.test.ts` |
| `P01-PHASE-NOT-RUN` | 必需检查未运行 | pass | `test/p01-4-report-aggregation.test.ts` |
| `P01-ENG-BUILD-SMOKE` | 构建产物 | pass | `test/p01-4-build-smoke.test.ts` |
| `P01-PHASE-REPORT` | 报告完整性 | pass | `test/p01-4-report-aggregation.test.ts` |

## 6. P01 覆盖子集（T03 / T24 / T26 / T32）

P01 只覆盖下列**子集**，不冒充完整验收，也不提前建执行表：

| 索引 | P01 实际覆盖 | 明确不覆盖（后续） |
|---|---|---|
| **T03** | 当前存储原子性/竞争子集：组合创建/配置写入失败整组回滚、跨进程 CAS 恰一胜者、失败重开无残留 | 活动执行锁、Run/Attempt 认领与取消、迟到结果 |
| **T26** | 当前配置 CAS 基础：insert-only、`expectedRevision` 条件写入、`stale_dependency`、脱敏审计同事务 | 完整配置历史版本表、跨层策略编排 |
| **T32** | 项目标签：规范化、非法输入拒绝、任一/全部筛选、去重计数 | Phase/Feature/Task 层级标签与跨层求和、按标签启动 Batch |
| **T24** | 默认/完整策略与来源基础：完整条目整体替换、政策段级覆盖、逐项 `global_default`/`project_default` 来源 | 完整 **Task 策略复制**（`tasks.execution_config`）属 P03 |

## 7. 干净快照发现并修复的前序集成回归

首次干净复跑（受测 commit `2a3c33b`）在 `test/p01-4-fixture.test.ts` 暴露 2 个**环境相关**失败：
F-002 安全清理用例假设受测仓库根位于系统临时目录**之外**，而干净快照本身位于临时目录内，导致

- 「未知根」用例先经授权检查（目标落入 `realpath(tmpdir())` 之内）再命中受保护路径，得到
  `protected` 而非期望的 `not_authorized`；
- 「符号链接逃逸」用例的链接目标（仓库根）落在授权临时根之内，逃逸未被触发。

修复（commit `542b89b`）：用例改用**嵌套授权根**与业务子目录，使 `not_authorized` 与
`symlink_escape` 判定相对授权根而非相对 `tmpdir`，断言语义与错误类别不变（在仓库根位于
临时目录内的克隆中复跑通过）。该修复不改变产品实现，仅移除测试对执行位置的隐式依赖。
随后在受测 commit `815e9e6` 上完整复跑七条命令并通过。

另在 F-010 工具内修复两处自身缺陷：`commands.json` 直接序列化 `runDir` 泄漏 macOS 临时目录
realpath（`/private` 前缀，已改为合并 raw/realpath 前缀统一脱敏）；realpath 前缀在快照创建
前解析导致 `ENOENT`（已改为 clone/checkout 后再解析）。最终证据中不存在快照/仓库/用户/临时
绝对路径。

## 8. 已知缺口与 not_run（不以注入或冒充折算通过）

| 项目 | 状态 |
|---|---|
| Windows / WSL / Linux 平台验收 | not_run（macOS 是唯一正式验收平台） |
| 强 OS 沙箱 / 隔离执行 | 未支持（首版为用户明确授权的可信项目模式） |
| 模型 Live 调用（Pi SDK 未安装、未调用） | not_run |
| Host 网络接口、认证与 CLI 业务命令 | not_run（后续阶段，未编造命令） |
| Runtime / 执行表（Phase/Feature/Task/Run/Attempt/Batch/Session）/ DAG 调度 | not_run（后续阶段） |
| Task 策略复制（`tasks.execution_config`） | not_run（P03） |
| 真实断电 / 磁盘满生产链路演练 | not_run（本轮为确定性故障注入） |
| T03/T24/T26/T32 **完整**验收 | not_run（仅 P01 子集，见 §6） |

上述能力在 `accept:p01` 报告中标为 `P01-OOS-*`（`not_run`/`unsupported`），不计入必需项通过数。

## 9. Harness 验证策略交接（本任务不修改 executor/agent 配置）

- 仓库级验证为 `npm test`（开发内循环）；`npm run verify`（锁文件预检 + test / typecheck /
  build 串联，fail-closed）为工程检查编排；阶段验收为 `npm run accept:p01`。
- 建议 Harness 将本仓库 Feature 验证命令对齐 `npm run verify`、阶段验收命令对齐
  `npm run accept:p01`，以退出码为通过依据。
- 本任务**未**自动修改任何 executor / agent / YAML 配置；负向验收纪律（不得删测试、降低门槛
  或扩大权限恢复）记录于操作说明与交接文档。

## 10. 结论

P01 在 macOS 干净源码快照上的七条命令（`npm ci` / `npm test` / `npm run typecheck` /
`npm run build` / `npm run verify` / `npm run accept:p01` ×2）真实退出码全部为 0；受测
commit `815e9e6…` 工作树 `clean`，连续两次 `accept:p01` 结论均为 `pass`（14/14），报告与
证据可重验、无个人/临时绝对路径、无凭据。干净快照复跑发现的前序夹具测试位置依赖回归已修复并
在新的受测 commit 上复验。P01 范围（FR-1/FR-2 持久化闭环、回滚/CAS、制品缺失/恢复、
当前配置/项目标签）验收通过；T03/T24/T26/T32 仅覆盖 P01 子集，其余能力明确 `not_run`。
下一阶段（P02）可基于本受测 commit `815e9e6…` 的已验收 Core 端口继续。
