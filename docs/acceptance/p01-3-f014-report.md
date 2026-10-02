# P01-3 Feature 验收报告（F-014）

- 验收日期：2026-10-03
- 验收平台：macOS 26.6.2（arm64），Node `22.19.0` / npm `10.9.3` / SQLite `3.53.4` /
  better-sqlite3 `13.0.3` / drizzle-orm `0.45.3` / Git `2.50.1`
- 受测代码 commit：`60e93086b74009f3fa447c4153c0670c8417f2ff`（分支
  `feat/2026-10-01-23-44-21_p01-3`，F-013 提交；本报告与配套文档在其后作为 F-014 文档提交，
  不改变受测代码）
- 范围界定：本报告是 **P01-3 项目身份与当前配置服务**的 Feature 验收，**不是** P01 阶段验收，
  也不提供 `accept:p01`。结论均来自真实命令退出码与可核对证据；不以 Nezha/Harness 的
  completed 状态代替代码验收。

## 1. 输入文档版本

设计输入为 Harness 知识目录 `architecture-redesign/`（非本仓库，以内容哈希固化版本）。本 Feature
实际依据的主要文档及其 SHA-256：

| 文档 | SHA-256 |
|---|---|
| `08-migration-roadmap.md` | `c6f527bd0846e805189b6ea8369cedb90442f6254198a3216dc3600c3d9c04a6` |
| `core-design/01-system-structure.md` | `1f66552a4e7e7b83c81f33138fbe81d5d9e4e5d9cb6ae5b69b92766e143c7490` |
| `core-design/02-domain-and-lifecycle.md` | `6fabe0e602e2e22667a9cf3e37c0b9b85049e96a1b51d7cf4876e18096f65f99` |
| `core-design/03-storage-and-transactions.md` | `c393f95c96d62c9ec708e3043fde78194c85acea2ea1dad6924b31fd83f7183d` |
| `core-design/06-project-and-context.md` | `ea9ef3e50e9f9ea5423ca673e41f6d3397996fd774c543b268316397d00c1394` |
| `core-design/11-database-model.md` | `57dc3c6eab520fea43b5078a131821525f5c85336c09990719f10f9b705e5fa9` |
| `core-design/07-verification-and-delivery.md` | `0bad1d917e9148d587924dfdd6c1901dd8cce6df159fe7a0a2c408c9ae3c11da` |
| `core-design/09-testing-and-implementation.md` | `69912f251a79be62617f80786a5e73e4db90d674977a32fad90282e8b4a213ad` |
| `core-design/10-repository-and-release.md` | `1149abf7b88370e74867501fd412593a7f5847ac58de7fc8a673e5ed4b0edf06` |

PRD：`p01-project-config.md`（版本 0.2，2026-10-01）。实施前置契约：
[docs/p01-3-application-contract.md](../p01-3-application-contract.md)。

前序基线（均为当前分支祖先，实际端口与测试在库）：P01-1 工程骨架 `44c8c30…`
（[p01-1-f006-report.md](p01-1-f006-report.md)）；P01-2 SQLite 原子存储与制品落盘 `74934ac…`
（[p01-2-f014-report.md](p01-2-f014-report.md)）。开工时在受控快照执行 `npm run verify` 返回 0
（20 files / 443 tests），确认前序能力可用、无阻塞。

## 2. 实现范围（F-001 ~ F-013）

- **F-001**：核验 P01-1/P01-2 已验收基线与端口；整理 P01-3 Core 应用契约、复用规则、配置语义、
  存储最小扩展与脱敏变更记录落点；记录设计张力与范围边界。
- **F-002**：项目名称/描述/标签运行时校验与确定性标签规范化（`trim → NFC → ASCII 小写 →
  实体内去重`，字段定位，长度/数量上限），注册/编辑/筛选共用。
- **F-003**：统一 `PathService`——稳定 `dataNamespace="shiploop"` 数据根解析、受控项目/制品定位、
  受权定位（存在性 + 归属核验）、符号链接逃逸三层防线。
- **F-004**：只读仓库路径检查适配器——真实 Git 解析 `canonicalPath`/`gitCommonDir`、
  `gitdir-sha256` 身份派生、拒绝裸仓库/子目录、独立 argv 与有限超时。
- **F-005**：`ProjectService.registerRepository`——只读检查在写事务外、项目+绑定单事务原子保存、
  同 `canonical_path` 幂等复用、同 remote 多 clone 分别注册、跨进程竞争恰一胜者。
- **F-006**：项目身份查询与元数据 CAS 编辑；迁移 v2 建立 `state_events`，编辑成功同事务追加
  脱敏记录，失败整组回滚。
- **F-007**：项目标签任一/全部筛选、有限分页（默认 50 / 上限 200）与项目层去重计数；
  `json_each` 绑定参数查询。
- **F-008**：配置版本化校验——`schemaVersion` 显式升级 1→2、政策子集（`executionLimits` /
  `verification` / `securityPolicy` 仅 `trusted_project`）、凭据引用卫生、可信装配注入的窄能力
  目录兼容性检查、合法 ≠ 可执行。
- **F-009**：有效配置合并与来源——键级继承、完整策略条目整体替换、政策段级整体覆盖、
  逐项 `global_default`/`project_default` 来源、无效来源不降级、`configured:false`。
- **F-010**：`ConfigurationService` 全局/项目当前配置创建（insert-only）与 CAS 更新；
  一致性视图 `stale_dependency` 前置条件；脱敏审计同事务；跨进程竞争恰一胜者。
- **F-011**：当前配置/有效配置查询与普通脱敏导出；损坏/未知版本 `corrupt` 不回落；只读无副作用。
- **F-012**：`openCoreApplication` 受控装配公共入口（经 `shiploop-core/assembly` 子路径），
  独立可编译示例与构建产物非源码 cwd 冒烟。
- **F-013**：FR-1/FR-2/FR-3 集成验收矩阵、失败分支回归守护与干净快照六步证据。
- **F-014**（本报告）：[p01-3-operations.md](../p01-3-operations.md) 操作说明、
  [p01-4-handoff.md](../p01-4-handoff.md) 接口交接（P01-4/P02）与本报告，含文档示例编译/运行核验。

## 3. 环境与版本

| 项 | 值 |
|---|---|
| 平台 | macOS 26.6.2（arm64，Build 25G83） |
| Node.js | `22.19.0` |
| npm | `10.9.3` |
| SQLite（驱动查询） | `3.53.4` |
| better-sqlite3 | `13.0.3`（精确锁定） |
| drizzle-orm | `0.45.3`（精确锁定） |
| Git | `2.50.1 (Apple Git-155)` |
| 测试运行器 | Vitest `5.0.3` |

环境记录证据：[`evidence-p01-3/00-environment.log`](evidence-p01-3/00-environment.log)。
命令/退出码/耗时记录：[`evidence-p01-3/00-commands.log`](evidence-p01-3/00-commands.log)。

## 4. 正向验收

### 4.1 F-013 干净快照六命令（受测实现 commit `60e9308`）

快照为 `git archive` 源码 tar 到系统临时目录（排除 `node_modules` / `.git` / `dist`），
`npm ci` 重建依赖后在无源码 cwd 下执行。命令、退出码、耗时记于
[`evidence-p01-3/00-commands.log`](evidence-p01-3/00-commands.log)。

| # | 命令 | 退出码 | 耗时 | 证据 |
|---|---|---|---|---|
| 1 | `npm ci` | 0 | 3s | [01-npm-ci.log](evidence-p01-3/01-npm-ci.log) / [.exit](evidence-p01-3/01-npm-ci.exit) |
| 2 | `npm test` | 0（34 files / 695 tests） | 7s | [02-npm-test.log](evidence-p01-3/02-npm-test.log) / [.exit](evidence-p01-3/02-npm-test.exit) |
| 3 | `npm run typecheck` | 0 | 1s | [03-typecheck.log](evidence-p01-3/03-typecheck.log) / [.exit](evidence-p01-3/03-typecheck.exit) |
| 4 | `npm run build` | 0（含 dist `./assembly` 冒烟） | 0s | [04-build.log](evidence-p01-3/04-build.log) / [.exit](evidence-p01-3/04-build.exit) |
| 5 | `npm run verify` | 0（`PASS 3/3`） | 7s | [05-verify.log](evidence-p01-3/05-verify.log) / [.exit](evidence-p01-3/05-verify.exit) |
| 6 | dist 非源码 cwd 装配闭环 | 0 | 0s | [06-dist-assembly-closed-loop.log](evidence-p01-3/06-dist-assembly-closed-loop.log) / [.exit](evidence-p01-3/06-dist-assembly-closed-loop.exit) |

第 6 步在源码树之外从快照构建产物 `packages/core/dist` 加载 `shiploop-core/assembly`：打开 →
注册真实临时 Git 仓库 → 全局/项目配置 → 有效配置来源 → 受权定位 → 关闭重开逐字段一致，
证明构建产物不依赖源码 cwd 或开发机路径。证据已脱敏（`<SNAPSHOT-ROOT>` / `<HOME>` 占位）。

### 4.2 F-014 文档核验与工作区回归

- 操作说明 [p01-3-operations.md](../p01-3-operations.md) §6 的最小示例与
  [`examples/p01-3-standalone.ts`](../../examples/p01-3-standalone.ts)、
  [`test/p01-3-fr-acceptance-closed-loop.test.ts`](../../test/p01-3-fr-acceptance-closed-loop.test.ts)
  同构；
- 新增 [`test/docs-p01-3-operations.test.ts`](../../test/docs-p01-3-operations.test.ts)（5 用例）：
  在真实临时 Git 仓库与数据根上用公开装配入口跑通操作说明示例（注册/重复结果、CAS 编辑、
  全局+项目配置、有效配置来源、脱敏导出、受权定位、关闭重开一致），并交叉核对文档引用的真实
  常量（namespace、`core.sqlite`、`schemaVersion=2`、导出格式版本、标签/分页上限、资源类型）；
  同时守护交接文档指向真实可复跑入口、验收报告记录命令/证据/差距；
- F-014 工作区回归：`npm test` → 0（**35 files / 700 tests**）；`npm run verify` → 0（`PASS 3/3`）。证据
  [07-f014-workspace-verify.log](evidence-p01-3/07-f014-workspace-verify.log) /
  [.exit](evidence-p01-3/07-f014-workspace-verify.exit)（已脱敏，工作区路径以 `<WORKSPACE-ROOT>` /
  `<NODE-PREFIX>` / `<TMPDIR>` 占位）；
- 文档中不存在未提供的 CLI 命令（本阶段无 CLI）。

### 4.3 FR 分支 → 测试映射（P01 子集）

| FR / T 项 | 承担测试（`test/`） | 说明 |
|---|---|---|
| FR-1 注册/重复/符号链接/同 remote 多 clone | `project-registration.test.ts`（+ `helpers/register-race-child.ts`） | 跨进程竞争恰一胜者 |
| FR-1 仓库检查拒绝分支与只读性 | `repository-inspector.test.ts` | 真实 Git |
| FR-1 元数据校验与 CAS/审计回滚 | `project-metadata-validation.test.ts`、`project-metadata-service.test.ts` | — |
| T32 子集：标签筛选/分页/计数 | `project-tag-filter.test.ts` | 项目层，不跨层级求和 |
| FR-2 配置结构/版本/秘密/政策 | `settings-schema-v2.test.ts` | — |
| FR-2 能力兼容性 fail-closed | `runtime-capabilities.test.ts` | 合法 ≠ 可执行 |
| T03/T26 子集：insert-only/CAS/stale_dependency/审计回滚 | `configuration-service.test.ts`（+ `helpers/settings-race-child.ts`）、`sqlite-cas-and-atomicity.test.ts`（+ `helpers/cas-race-child.ts`） | 跨进程竞争 |
| T24 子集：合并与来源 | `effective-settings-merge.test.ts`、`settings-query-service.test.ts` | 非完整 Task 策略复制 |
| FR-3 namespace/逃逸/跨项目 | `path-service.test.ts` | — |
| 装配闭环与导出面 | `core-assembly.test.ts` | — |
| 文档守护 | `docs-p01-3-operations.test.ts`、`docs-p01-3-application-contract.test.ts` | F-014 新增 |

## 5. 已建表 / 字段 / 迁移与配置 Schema

- 迁移清单：`packages/core/src/adapters/sqlite/migrations.ts` 的 `SQLITE_MIGRATIONS`。
  当前两个版本：`version=1`（六表）与 `version=2`（`state_events` 审计表）。执行记录写入
  `schema_migrations`（`version` 唯一、`checksum`、`applied_at` UTC 毫秒）。
- 六表字段与约束沿用 P01-2（见 [p01-2-f014-report.md](p01-2-f014-report.md) §5）；
  P01-3 未改其语义。
- `state_events`（v2）：`id`、`project_id`（可空，CHECK 限定仅 `aggregate_type='global_settings'`
  可为空；有值时项目外键 `ON DELETE RESTRICT`）、`sequence`（唯一、数据库持久全局游标）、
  `event_type`、`aggregate_type`、`aggregate_id`、`aggregate_revision`、`payload`（CHECK
  `json_valid` + object）、`occurred_at`；不建 run/task/attempt 悬空外键。
- 应用事件类型：`project.metadata_updated`、`settings.global_updated`、`settings.project_updated`；
  payload 只含变更字段名/策略键名/`schemaVersion` 摘要，绝不含值/引用/秘密。
- 配置 Schema：`SETTINGS_SCHEMA_VERSION = 2`；导出格式 `SETTINGS_EXPORT_FORMAT_VERSION = 1`。
- 显式偏离（已记录并请求核对）：`state_events.project_id` 可空（设计 11 §9 标为必填），依据见
  [p01-3-application-contract.md §6.3 / §9-1](../p01-3-application-contract.md)。

## 6. 已建能力之外的明确边界

- **未建表**：Phase / Feature / Task / Run / Attempt / Batch / Session / Chat / 知识 / 记忆 /
  通知 / 审批等执行与协作表，以及 `project_profiles`、`capability_modules`、
  `verification_batches`、`check_results`、`tasks.execution_config`、配置历史版本表。
- **未做**：Host 网络接口与认证、CLI 命令与参数解析、Runtime/Pi SDK 执行与模型调用、
  Task 策略复制、DAG 调度与认领/活动执行锁、rebind / 源代码迁移、存量基线扫描、
  `accept:p01` 阶段验收。
- 可信项目模式 ≠ 强 OS 沙箱：P01-3 不宣称强文件隔离，要求强隔离的任务被明确拒绝
  （`unsupported_isolation`），不静默降级。

## 7. 已知缺口与 not_run（不以注入或冒充折算通过）

| 项目 | 状态 |
|---|---|
| Windows / WSL / Linux 平台验收 | not_run（macOS 是唯一正式验收平台） |
| 强 OS 沙箱 / 隔离执行 | 未支持（首版为用户明确授权的可信项目模式） |
| 模型 Live 调用（Pi SDK 未安装、未调用） | not_run |
| Host 网络接口、认证与 CLI 命令 | not_run（后续阶段） |
| Runtime / 执行表 / DAG 调度 / 活动执行锁与取消 | not_run（后续阶段） |
| Task 策略复制（`tasks.execution_config`） | not_run（P03） |
| 真实断电 / 磁盘满生产链路演练 | not_run（前序为显式注入故障） |
| `accept:p01` 阶段验收与阶段最终报告 | not_run（由 P01-4 交付） |
| T03/T26/T32/T24 **完整**验收 | not_run（本 Feature 仅交付子集，见 §4.3） |

## 8. Harness 验证策略交接（本任务不修改 executor/agent 配置）

- 仓库级默认验证为 `npm test`（开发内循环）；`npm run verify`（锁文件预检 + `npm test` /
  `typecheck` / `build` 串联，fail-closed）为工程检查编排。
- 建议 Harness 将本仓库 Feature 验证命令对齐为 `npm run verify`，以编排退出码作为通过依据。
- 本任务**未**自动修改任何 executor / agent / YAML 配置；负向验收纪律（不得通过删测试、降低
  门槛或扩大权限恢复）记录于交接文档。

## 9. 结论

P01-3 在 macOS 干净快照上的六条命令（`npm ci` / `npm test` / `npm run typecheck` /
`npm run build` / `npm run verify` / dist 非源码 cwd 装配闭环）真实退出码全部为 0
（F-013 快照 34 files / 695 tests）；F-014 新增文档示例核验后工作区 `npm test` 35 files /
700 tests、`npm run verify` 仍返回 0，套件内无 skip；操作说明与交接文档引用的接口/常量由
文档守护测试与编译检查核验；源码、产物与证据无开发机绝对路径依赖、无凭据、未执行 npm 发布。
本结论仅限上述 P01-3 项目身份与当前配置服务范围，不代表 P01 阶段验收或任何业务 Live 验收
通过。阶段最终报告与 `accept:p01` 由 P01-4 交付。
