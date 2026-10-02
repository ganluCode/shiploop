# P01-4 P01 持久化闭环验收 — 阶段验收契约与检查清单

- 对应任务：F-001（核验前序已验收代码，建立阶段必需检查清单、需求映射与可复跑验收约定）。
- 文档状态：P01-4 实施前置契约（验收约定与检查清单，**不是**阶段验收报告）。
- 适用平台：macOS（首个正式支持平台）；Windows/WSL/Linux 未验收。
- 输入依据：PRD `p01-acceptance.md`（版本 0.2，2026-10-01）与共同执行约束 `execution-contract.md`
  （开发查阅路径：`../../../../ai-coding/shiploop-harness/workspace/features/2026-10-01-23-44-21_p01-4-p01/input/`，
  非本仓库、非运行时依赖），以及 Harness 知识目录 `architecture-redesign/`（不在本仓库，版本见 §7.1）。
- 本文只规定 **P01-4 的验收约定、检查清单与复用边界**；它描述 F-002 ~ F-010 应实现的检查项
  与证据形态，不代替任何任务的验收报告，也不交付 `accept:p01` 的实现（由 F-008 交付）。
  产品实现只在 ShipLoop 目标仓库进行，Harness 仅编排。
- 本文不静默改变领域语义；发现的矛盾集中记录于 §8 并请求核对。

---

## 1. 前序基线核验（开工核对）

### 1.1 分支与提交

- 实际执行分支：`feat/2026-10-01-23-44-21_p01-4-p01`（worktree
  `/Users/ganlu/Documents/my-dev/code/mygit/AI/shiploop-2026-10-01-23-44-21_p01-4-p01`）。
- 基线（`feature.yaml.metadata.base_branch`）：`feat/2026-10-01-23-44-21_p01-3`
  （= 当前 HEAD）。
- 已核验祖先链（`git merge-base --is-ancestor`，均为真）：

| 阶段前置 | 执行分支 | tip commit | 已验收报告 |
|---|---|---|---|
| p01-engineering（P01-1） | `feat/2026-10-01-23-44-21_p01-1` | `44c8c30997c46b55d514bc429fcaf9337d755484` | `docs/acceptance/p01-1-f006-report.md` |
| p01-state-artifacts（P01-2） | `feat/2026-10-01-23-44-21_p01-2-sqlite` | `74934acba07f6a33c9957ec66ad2ccec2606f828` | `docs/acceptance/p01-2-f014-report.md` |
| p01-project-config（P01-3） | `feat/2026-10-01-23-44-21_p01-3` | `2578a66e28f49155fabdd5935bc228b9702459b5` | `docs/acceptance/p01-3-f014-report.md` |

- P01-3 已验收**受测代码** commit 为 `60e9308`（F-013）；`2578a66` 为其后的 F-014 文档提交
  （操作说明、交接与报告），不改变受测代码。P01-1/P01-2 的验收报告与脱敏证据
  （`docs/acceptance/evidence-p01-1|2|3/`，`.gitignore` 有显式例外）均随分支携带。
- 结论：**前序三条前置均在当前分支历史内，端口、测试与验收报告实际存在，无阻塞项**，
  F-001 不需以前序缺失为由记录阻塞，也不在本 Feature 重建工程或用占位实现顶替。

### 1.2 已验收能力与端口确实存在（非占位）

| 能力 | 已验收端口 / 入口 | 位置 |
|---|---|---|
| 组合根 | `openCoreApplication(options)` → `CoreApplication`（`dataRoot`/`pathService`/`stateStore`/`artifactStore`/`artifactFileStore`/`repositoryInspector`/`projectService`/`configurationService`/`close()`） | `packages/core/src/adapters/composition.ts`，经 `shiploop-core/assembly` 导出 |
| 项目身份 | `ProjectService`：`registerRepository` / `getProject` / `getRepositoryBinding` / `updateProjectMetadata` / `listProjects` / `countProjectLabels` | `packages/core/src/application/project-service.ts` |
| 仓库检查 | `RepositoryInspector.inspect`（只读 Git/文件，独立 argv + 有限超时） | `packages/core/src/adapters/fs/repository-inspector.ts` |
| 当前配置 | `ConfigurationService`：`createSettings` / `updateSettings` / `getCurrentSettings` / `getEffectiveSettings` / `exportSettings` | `packages/core/src/application/configuration-service.ts` |
| 有效配置合并 | `mergeEffectiveSettings`（纯函数，键级继承 + 条目整体替换 + 政策段级覆盖） | `packages/core/src/application/effective-settings.ts` |
| 制品 | `ArtifactStore`（`registerArtifact`/`getArtifact`/`transitionArtifact`/`getArtifactInputRef`/`listArtifacts`）、`ArtifactFileStore`、发布编排 `createArtifactPublisher`、核对 `createArtifactVerifier` | `packages/core/src/ports/*`、`application/artifact-publish.ts`、`application/artifact-verify.ts` |
| 路径 | `PathService`：`dataRoot` / `databaseFilePath` / `projectDirectory` / `locateProjectResource` | `packages/core/src/adapters/fs/path-service.ts` |
| SQLite 底座 | `openSqliteStorageSession`、`migrateSqliteStorage`、`SQLITE_MIGRATIONS`（v1 六表 + v2 `state_events`） | `packages/core/src/adapters/sqlite/*` |
| 结构化错误 | `StorageError.kind` ∈ `validation`/`not_found`/`conflict`/`busy`/`corrupt`/`unsupported_version`/`ownership` | `packages/core/src/ports/errors.ts` |

测试实际存在：`test/` 下 35 个 `*.test.ts`（含组合根闭环、跨进程竞争子进程夹具），
由 `npm test` 默认收集（`vitest.config.ts`：`passWithNoTests:false`、`exclude` helpers/fixtures）。

### 1.3 基线验证命令与退出码

在依赖由锁定版本 `npm ci` 重建后执行（Node `22.19.0` / npm `10.9.3` / lockfileVersion `3`）：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `npm ci` | 退出 0（47 packages，0 vulnerabilities） |
| 工程验证 | `npm run verify` | **退出 0（`PASS 3/3`）** |
| ├─ 测试 | `npm test` | 退出 0，**35 test files / 700 tests passed**，套件内无 skip |
| ├─ 类型 | `npm run typecheck` | 退出 0 |
| └─ 构建 | `npm run build` | 退出 0（三个包 dist 入口可加载，`./assembly` 冒烟通过、无副作用） |

结论：前序已验收能力在 P01-4 分支可用；F-001 的检查清单即建立在这些真实端口与测试之上。

---

## 2. 阶段必需检查清单与 FR 需求映射

### 2.1 稳定检查 ID 约定

- 检查 ID 形如 `P01-<GROUP>-<NAME>`，全大写、连字符分隔，**跨运行稳定**；报告、证据目录名与
  阶段聚合都以此 ID 为业务身份，不使用展示名。
- `P01-ENG-*` 为工程检查；`P01-FR1-*`/`P01-FR2-*` 为 PRD FR 分支检查；`P01-PHASE-*` 为阶段
  控制检查（夹具失败、必需检查未运行、报告完整性）。
- 检查 ID 的机器可读清单由 F-007 的版本化报告 Schema 固定；F-001 只在此冻结 ID 集合与语义。
  **未知或重复的检查 ID 必须被拒绝**，不得被聚合为通过。

本阶段冻结的必需检查（全部为 `required`，任一非 `pass` 即使 `accept:p01` 非零退出）：

| 检查 ID | FR / 阶段分支 | 说明 | 承担任务 | 测试 / 命令入口 | 关键证据字段 |
|---|---|---|---|---|---|
| `P01-ENG-VERIFY` | 工程 | `npm run verify`（test/typecheck/build）退出 0 | F-008 | `npm run verify`（盘 `scripts/verify.ts`，步骤见 `packages` 根 `package.json`） | `exit_code`、`duration_ms`、`steps[].label`/`exit_code`、测试文件/用例计数 |
| `P01-FR1-NORMAL` | FR-1 **正常** | 经应用服务在临时数据根注册真实 Git 仓库、写全局/项目配置、发布固定正文制品 | F-003 | `test/p01-4-persistence-closed-loop.test.ts`（复用 `openCoreApplication`/`ProjectService`/`ConfigurationService`/`ArtifactStore`） | `project_id`、`repository_binding`、配置 `schema_version`/`revision`/`payload_digest`/`source`、`artifact.id`/`content_hash`/`size_bytes`/`locator`、源仓库指纹 |
| `P01-FR1-REOPEN` | FR-1 **重开** | 关闭全部连接后以新装配实例打开同一数据根，逐字段一致 | F-003 | 同上（重开阶段；不得只读原实例内存缓存） | 重开前后 `project_id`/绑定/元数据、配置 `schema_version`/`payload`/`revision`/有效来源、制品 `hash`/`size`/正文摘要、相对 `locator` |
| `P01-FR1-ROLLBACK` | FR-1 **回滚** | 组合创建首个写入后注入确定性异常，项目及绑定/初始配置全部不存在 | F-004 | `test/p01-4-sqlite-rollback-and-cas.test.ts`（复用 TEMP TRIGGER 故障注入；不得手工改库） | `injected_error`、前后行数、参与表全部为零、重开后仍无残留、既有正常项目/配置未受影响 |
| `P01-FR2-CONFIG` | FR-2 正常/拒绝 | 完整策略整体覆盖、当前值与来源重开读取、未知版本/未知 runtime/不完整策略拒绝、凭据仅保存引用 | F-006 | `test/p01-4-config-and-tags.test.ts`（复用 `settings-schema-v2`/`configuration-service`/`effective-settings-merge`/`settings-query-service`） | `scope`、`schema_version`、`revision`、精确值、`source.kind`/`sourceKey`/`scopeRevision`、结构化错误 `kind`/`reason` |
| `P01-FR2-ROLLBACK` | FR-2 **回滚** | 在当前配置更新与脱敏变更记录提交之间注入失败，`payload`/`revision`/记录全部回滚 | F-004 | 同上 | `injected_error`、预期错误、前后 `payload`/`revision`、`state_events` 行数、操作身份、副作用断言 |
| `P01-FR2-CAS` | FR-2 CAS | 真实独立进程 + 同步屏障，同一旧 `revision` 竞争更新恰一成功一 `conflict`，`revision` 仅增一次 | F-004 | 同上 + `test/helpers/settings-race-child.ts`、`test/helpers/cas-race-child.ts` | `expected_revision`、胜者值、`success_count=1`、`conflict_count=1`、`revision_delta=1`、子进程退出码 |
| `P01-FR2-TAGS` | T32 项目标签 | 标签规范化、非法数组拒绝、任一/全部筛选及去重计数 | F-006 | `test/p01-4-config-and-tags.test.ts`（复用 `project-tag-filter`） | 规范化标签、命中 `project_id` 集合与计数、`match_mode`、非法输入错误、非法更新后元数据/`revision` 不变 |
| `P01-FR2-ARTIFACT-MISSING` | FR-2 **制品缺失** | 删除本次正文后读取/核对报告 `missing`/`corrupt`，不返回有效引用或空正文 | F-005 | `test/p01-4-artifact-negative.test.ts`（复用 `createArtifactVerifier`） | `artifact_id`、原 `hash`/`size`、逻辑 `locator`、文件缺失事实、索引诊断、其他制品/项目/配置仍可读 |
| `P01-FR2-ARTIFACT-RECOVERY` | FR-2 制品恢复 | 发布中断后重开核对；`pending` 仅 hash/size 匹配补 `ready`；孤儿保留/安全隔离 | F-005 | 同上 + `test/helpers/interrupt-publish-child.ts` | 子进程退出、`pending` 状态、`ready` 迁移、`hash`/`size` 核验、孤儿处置、路径穿越/符号链接拒绝 |
| `P01-PHASE-FIXTURE` | **夹具失败** | 夹具准备失败明确 `fail`/`not_run`，阶段非零，且保留已取得证据 | F-007 / F-008 | `test/p01-4-acceptance-controller.test.ts`（注入准备错误） | `fixture_status`、失败原因、依赖检查状态、阶段退出码、证据保留 |
| `P01-PHASE-NOT-RUN` | **必需检查未运行** | 未提交结果/启动失败/超时/被跳过的必需项标 `not_run`，不得聚合为通过 | F-007 / F-008 | `test/p01-4-report-aggregation.test.ts` | 必需检查清单、`status`、缺失结果、聚合结论、退出码 |
| `P01-ENG-BUILD-SMOKE` | 构建产物 | 非源码 cwd 从 dist 装载公共入口与迁移执行闭环，路径检查无个人绝对路径/Nezha 依赖 | F-009 | `test/p01-4-build-smoke.test.ts` + `scripts/core-assembly-smoke.mjs` | `dist_entry`、`cwd_relative`、已加载模块、迁移资源在位、路径扫描结果、文件清单摘要 |
| `P01-PHASE-REPORT` | 报告完整性 | 版本化报告 Schema、逐项结果、证据 `path`/`hash`/`size`、总体结论可验证 | F-007 | `test/p01-4-report-aggregation.test.ts` | `report_schema_version`、输入计划摘要、受测 commit、工具版本、`checks[]`、`evidence[]`、总体结论、已知限制 |

> 上表「测试入口」对尚未实现的后继任务（F-003 ~ F-009）为**约定文件/入口**；F-001 只冻结
> 检查 ID、分支语义与证据字段，实际测试由对应任务按 TDD 落地。`P01-ENG-VERIFY` 与所有
> 复用前序的回归入口现在即已存在。

### 2.2 FR 分支覆盖核对

PRD §3.2 要求的每个 FR 分支都有稳定检查 ID 承接，且每项都断言**真实状态/文件/返回值**，
不以「日志包含成功文字」或测试数量替代：

| 要求分支 | 承接检查 ID |
|---|---|
| FR-1 正常路径 | `P01-FR1-NORMAL` |
| FR-1 重开（关闭重开逐字段一致） | `P01-FR1-REOPEN` |
| FR-1 回滚（注入事务失败无半条记录） | `P01-FR1-ROLLBACK` |
| FR-2 正常 + 关键失败/拒绝 | `P01-FR2-CONFIG` |
| FR-2 回滚（配置 + 脱敏记录） | `P01-FR2-ROLLBACK` |
| FR-2 CAS 竞争 | `P01-FR2-CAS` |
| FR-2/T32 标签 | `P01-FR2-TAGS` |
| FR-2 制品缺失/损坏 | `P01-FR2-ARTIFACT-MISSING` |
| FR-2 发布中断恢复 | `P01-FR2-ARTIFACT-RECOVERY` |
| 夹具失败 | `P01-PHASE-FIXTURE` |
| 必需检查未运行 | `P01-PHASE-NOT-RUN` |
| 产物不依赖源码 cwd / 个人路径 | `P01-ENG-BUILD-SMOKE` |
| 报告/证据可验证 | `P01-PHASE-REPORT` |

### 2.3 前序必需回归由 `verify` 覆盖（不只核对测试数量）

`npm run verify` 的 `npm test` 步骤默认收集 `test/**/*.test.ts`（`passWithNoTests:false`，
不跳过），并由 [p01-3-fr-acceptance-closed-loop.test.ts](../test/p01-3-fr-acceptance-closed-loop.test.ts)
第 3 个用例作为 **fail-closed 守护**：列出的 FR 关键失败分支测试文件缺失、被移入 helpers、
或被 `.skip`/`.only`/`.todo` 静默跳过时守护失败。下列前序回归**实际入口**必须在阶段检查中
保持可运行（F-008 的 `P01-ENG-VERIFY` 退出 0 即覆盖；不得用删测试、`passWithNoTests` 或跳过
替代）：

| FR / T 分支 | 前序实际测试入口（`test/`） |
|---|---|
| FR-1 重复路径/符号链接、同 remote 多 clone、跨进程竞争注册、绑定回滚 | `project-registration.test.ts`（+ `helpers/register-race-child.ts`） |
| FR-1 仓库检查拒绝分支与只读性 | `repository-inspector.test.ts` |
| FR-1 非法标签/名称/描述、元数据 CAS 与审计回滚 | `project-metadata-validation.test.ts`、`project-metadata-service.test.ts` |
| T32 子集：标签筛选/分页/计数、防注入 | `project-tag-filter.test.ts` |
| FR-2 配置结构/版本/秘密/政策拒绝 | `settings-schema-v2.test.ts` |
| FR-2 能力兼容性 fail-closed、合法≠可执行 | `runtime-capabilities.test.ts` |
| FR-2 / T03/T26 子集：insert-only、CAS、跨进程竞争、`stale_dependency`、审计回滚 | `configuration-service.test.ts`（+ `helpers/settings-race-child.ts`）、`sqlite-cas-and-atomicity.test.ts`（+ `helpers/cas-race-child.ts`） |
| FR-2 / T24 子集：合并与来源 | `effective-settings-merge.test.ts`、`settings-query-service.test.ts` |
| FR-3 namespace/逃逸/跨项目 | `path-service.test.ts` |
| 装配闭环与导出面 | `core-assembly.test.ts` |
| 工具/驱动缺失失败而非 skip | `deterministic-test-harness.test.ts`、`sqlite-storage-fixture.test.ts` |

### 2.4 结果状态与聚合规则

- 每个检查的结果状态只有三种：`pass`、`fail`、`not_run`。**未提交结果、启动失败、超时与被
  跳过的必需项一律 `not_run`**，不得默认成功。
- 预期负例（如 `P01-FR1-ROLLBACK`、`P01-FR2-CONFIG` 的拒绝分支）只有在**错误断言与副作用
  断言同时通过**时才计为 `pass`；只有错误类型而没有「零半条记录」副作用证据不算通过。
- 聚合：任一必需检查 `fail` 或 `not_run`、证据缺失/损坏、报告写入失败 → 阶段结论非通过且
  `accept:p01` 非零退出。空结果集不得聚合为通过。
- 阶段外的能力（模型 Live、强沙箱、其他平台）标 `not_run`/未支持，且**不计入 P01 必需项的
  通过数**，不得折算。

---

## 3. 验收接口与可复跑约定

### 3.1 Core 装配与应用命令 / 查询（实际入口）

阶段验收必须经**产品公共入口**执行，不得用验收脚本直接插业务行替代：

- 装配：`import { openCoreApplication } from 'shiploop-core/assembly'`（源码期
  `packages/core/src/adapters/composition.ts`）。选项校验先于任何 I/O；只创建数据根本身；
  执行版本化迁移；`close()` 幂等，关闭后同根重开。
- 命令（写）：`registerRepository`、`updateProjectMetadata`、`createSettings`、`updateSettings`、
  `publishArtifact`（`createArtifactPublisher`）。
- 查询（读）：`getProject`、`getRepositoryBinding`、`listProjects`、`countProjectLabels`、
  `getCurrentSettings`、`getEffectiveSettings`、`exportSettings`、`locateProjectResource`、
  `readVerifiedContent`（`createArtifactVerifier`）。
- 输入契约要点：目标身份只来自 `scope` 或显式 `projectId`；`credentialRef`/`endpointRef`
  只传引用字符串；命令失败不得把回滚后的旧值/日志当作新状态。

### 3.2 版本化输入

| 版本化输入 | 当前值 | 落点 |
|---|---|---|
| 配置 `schemaVersion` | `2`（`SETTINGS_SCHEMA_VERSION`） | `packages/core/src/ports/settings-schema.ts` |
| 导出格式版本 | `1`（`SETTINGS_EXPORT_FORMAT_VERSION`） | `packages/core/src/application/configuration-service.ts` |
| SQLite 迁移版本 | `1`（六表）→ `2`（`state_events`） | `packages/core/src/adapters/sqlite/migrations.ts` |
| 阶段验收配置版本 | `configVersion`（F-008 冻结，建议 `1`） | 见 §3.4 |

未知协议/Schema 版本或能力必须明确拒绝，不猜测降级。

### 3.3 故障注入入口（复用前序，不新建第二套）

| 失败分支 | 入口 | 断言要点 |
|---|---|---|
| 项目+绑定统一回滚 | `test/project-registration.test.ts`（TEMP TRIGGER 注入绑定写失败） | 项目与绑定均不存在，零残留 |
| 元数据/配置审计注入回滚 | `test/project-metadata-service.test.ts`、`test/configuration-service.test.ts`、`test/p01-3-fr-acceptance-closed-loop.test.ts`（同一连接 `CREATE TEMP TRIGGER` on `state_events`） | 实体写入与 `revision` 一并回滚，修复后可继续 |
| 跨进程注册竞争 | `test/helpers/register-race-child.ts`（同步屏障 + 有限外层超时 + 退出核验） | 恰一 `registered`、一 `already_exists` |
| 跨进程配置 CAS 竞争 | `test/helpers/settings-race-child.ts`、`test/helpers/cas-race-child.ts` | 同旧 revision 恰一胜者，`revision` 只增一次 |
| 制品发布中断 | `test/helpers/interrupt-publish-child.ts`、`test/artifact-verify.test.ts` | 重开后 `pending` 仅 hash/size 匹配才补 `ready`；孤儿保留原位 |
| 阶段夹具准备失败 | F-007/F-008 验收控制器（注入准备错误） | 依赖检查 `not_run`，报告保留已取得证据，阶段非零 |

故障注入使用真实 SQLite / 真实 Git / 真实文件，不以 mock 次数或成功日志替代副作用断言。

### 3.4 报告位置、配置入口与有限超时

以下为 **F-007 / F-008 实现、F-001 冻结的约定**：

- **报告默认位置**：`artifacts/acceptance/p01/<run-id>/`（相对仓库根）。每次运行独立目录，
  互不覆盖：
  - `report.json`：版本化机器可读报告（与摘要同源）；
  - `summary.md`：简明可读摘要（同一结果源生成）；
  - `evidence/`：清理临时资源前导出/序列化的证据副本。
- **`run-id`**：`<UTC YYYYMMDDThhmmssZ>-<8 hex>`（由可注入 UTC 时钟 + 随机后缀派生），
  必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`、不含路径分隔符；非法 `run-id` 拒绝。
- **配置入口**：仓库内版本化 `acceptance/p01.config.json`（F-008 创建），字段含
  `configVersion`、`reportRoot`、`requiredChecks`（有序检查 ID）、`timeouts`（各步骤有限毫秒）。
  运行时校验拒绝未知 `configVersion`、非正超时与任何试图移除/关闭必需检查的配置。
  CLI/环境变量仅作**覆盖**，不得放宽必需检查集合。
- **CLI / 环境变量（F-008 约定）**：`npm run accept:p01 [-- --run-id <id> --report-dir <dir>
  --step-timeout-ms <ms> --verify-timeout-ms <ms>]`；环境变量
  `SHIPLOOP_ACCEPT_P01_RUN_ID` / `SHIPLOOP_ACCEPT_P01_REPORT_DIR` /
  `SHIPLOOP_ACCEPT_P01_STEP_TIMEOUT_MS`，并复用既有 `SHIPLOOP_VERIFY_STEP_TIMEOUT_MS`
  （`scripts/verify.ts`）。命令 argv/cwd 显式，不经不可信 Shell 拼接。
- **有限超时**：`npm run verify` 单步默认 `600_000ms`（已实现，可覆盖）；Git 夹具子进程
  `30_000ms`（`test/helpers/git-repo.ts`）；验收控制器各步骤与整体均为有限毫秒预算，超时后
  先核验进程停止（进程组 SIGKILL）再清理资源。
- **结果状态**：`pass` / `fail` / `not_run`（见 §2.4）。
- **证据保留**：证据在删除临时业务资源**之前**复制/序列化到报告目录；报告内证据引用为
  **相对路径**，临时资源路径用逻辑映射表达；**不导出完整环境变量、认证配置或原始秘密**；
  使用合成凭据测试配置/错误/命令输出证据的脱敏。清理只删除本次持有且位于临时授权根内的
  资源，拒绝用户仓库/未知根/符号链接逃逸。

### 3.5 证据保留规则

- 运行结束（成功或失败）都保留已取得的证据；失败路径同样写出报告（含失败项与 `not_run`
  项），不得因清理或报告写入失败而静默通过。
- 生成的报告位于 `artifacts/acceptance/p01/`（本仓库 `.gitignore` 忽略该目录，避免把临时
  运行产物混入版本控制）；需要随版本保存的**脱敏**证据副本放 `docs/acceptance/`（沿用
  P01-1/2/3 的 `evidence-p01-N` 惯例，必要时加 `.gitignore` 例外）。
- 报告不得以展示名称作为业务身份；不得包含 Harness 或个人目录作为运行依赖。

---

## 4. 阶段验收索引（T03 / T24 / T26 / T32）与范围边界

本阶段只覆盖下列**子集**，不得冒充完整验收，也不提前建执行表或宣称全量通过：

| 索引 | P01-4 实际覆盖子集 | 明确不覆盖（后续） |
|---|---|---|
| **T03** | 当前存储原子性/竞争子集：组合创建/配置写入失败注入整组回滚、跨进程 CAS 竞争恰一胜者、失败重开无残留 | 活动执行锁、Run/Attempt 认领与取消、迟到结果 |
| **T26** | 当前配置 CAS 基础：insert-only 首次创建、`expectedRevision` 条件写入、`stale_dependency` 一致性前置、脱敏审计同事务 | 完整配置历史版本表、跨层策略编排 |
| **T32** | 项目标签：规范化、非法输入拒绝、任一/全部筛选、去重计数 | Phase/Feature/Task 层级标签与跨层求和、按标签启动 Batch |
| **T24** | 仅当前默认/完整策略与**来源基础**：完整条目整体替换、政策段级覆盖、逐项 `global_default`/`project_default` 来源 | 完整 **Task 策略复制**（`tasks.execution_config`）属 **P03**；本阶段不建执行表 |

---

## 5. 平台、版本与依赖锁定

- 正式验收限 **macOS**；Windows/WSL/Linux 不作为当前通过条件。
- 沿用前序精确版本，不隐式升级：Node `22.19.0`、npm `10.9.3`、TypeScript `7.0.2`、
  Vitest `5.0.3`、`better-sqlite3` `13.0.3`、`drizzle-orm` `0.45.3`、
  `@types/better-sqlite3` `9.6.0`、`@types/node` `22.20.4`；`package-lock.json`
  `lockfileVersion` 为 `3`。新增依赖须明确授权并更新锁文件。
- 正式验收命令应在**无 `node_modules`/`dist` 残留的干净源码快照**中 `npm ci` 后执行（F-010）。

---

## 6. 非目标与边界

本次**无**以下能力，验收不得依赖也不得宣称：Host 网络接口（HTTP/SSE）与认证、CLI 命令与参数
解析、Runtime/Pi SDK 与模型调用（Live）、完整执行表（Phase/Feature/Task/Run/Attempt/Batch/
Session）、DAG 调度与认领、桌面端、强 OS 沙箱、rebind/源代码迁移、存量基线扫描、
Task 策略复制。

- 可信项目模式 ≠ 强 OS 沙箱；要求强隔离（`strong_sandbox` 等）被明确拒绝，不静默降级。
- 不新增通用事件工作流平台；状态推进采用显式调用。
- **不自动修改 Harness YAML / executor / agent 配置**；`npm run verify` 与阶段检查的对齐由
  操作者在执行前核对（见 §7）。

---

## 7. 输入版本与验证策略交接

### 7.1 输入文档版本

设计输入为 Harness 知识目录 `architecture-redesign/`（不在本仓库，以内容哈希固化版本）。
本阶段实际依据的主要文档及其 SHA-256（沿用 P01-3 报告，实施前应复核）：

| 文档 | SHA-256 |
|---|---|
| `08-migration-roadmap.md` | `c6f527bd0846e805189b6ea8369cedb90442f6254198a3216dc3600c3d9c04a6` |
| `core-design/01-system-structure.md` | `1f66552a4e7e7b83c81f33138fbe81d5d9e4e5d9cb6ae5b69b92766e143c7490` |
| `core-design/02-domain-and-lifecycle.md` | `6fabe0e602e2e22667a9cf3e37c0b9b85049e96a1b51d7cf4876e18096f65f99` |
| `core-design/03-storage-and-transactions.md` | `c393f95c96d62c9ec708e3043fde78194c85acea2ea1dad6924b31fd83f7183d` |
| `core-design/06-project-and-context.md` | `ea9ef3e50e9f9ea5423ca673e41f6d3397996fd774c543b268316397d00c1394` |
| `core-design/07-verification-and-delivery.md` | `0bad1d917e9148d587924dfdd6c1901dd8cce6df159fe7a0a2c408c9ae3c11da` |
| `core-design/11-database-model.md` | `57dc3c6eab520fea43b5078a131821525f5c85336c09990719f10f9b705e5fa9` |

### 7.2 验证策略交接（不修改配置）

- 仓库级默认验证为 `npm test`；`npm run verify`（锁文件预检 + test/typecheck/build 串联，
  fail-closed）为工程检查编排。`accept:p01` 由 F-008 提供，串联 `verify` 与固定必需检查组。
- **建议 Harness 将本仓库验收命令对齐为 `npm run verify`（Feature）与 `npm run accept:p01`
  （阶段）**，以退出码为通过依据。本任务未自动修改任何 executor/agent/YAML 配置。

---

## 8. 已记录的设计张力与待核对项（不静默改变语义）

P01-4 只**记录并携带**前序已登记的核对请求，不在本阶段静默决定；实施中如再发现接口/领域语义
冲突，先记录并请求核对。与前序一致、对 P01-4 直接相关的张力：

1. **`state_events.project_id` 可空**（P01-3 §6.3/§9-1）：设计 11 §9 标为必填，但全局配置变更
   无适用项目；现以「可空 + CHECK（仅 `global_settings` 允许空）」表达，属显式偏离，**请求核对**。
2. **配置政策段与数值上限**（P01-3 §9-2）：设计未给定政策子集与上限，现由实施契约冻结
   （`schemaVersion=2`，`executionLimits`/`verification`/`securityPolicy`），**请求核对**。
3. **数据 `dataNamespace` 值**（P01-3 §9-3）：设计要求发布前确定精确系统路径，现暂定
   `shiploop` 与 macOS 默认根，**请求确认**。
4. **元数据长度/数量上限**（P01-3 §9-5）：设计只规定标签规范化，未规定上限，现为实现值，
   **请求核对**。
5. **仓库检查支持范围与 `repoIdentity` 派生**（P01-3 §9-6）：设计未规定子目录/裸仓库/linked
   worktree 与身份派生，现为实现值，**请求核对**。
6. **政策段合并粒度**（P01-3 §9-7）：设计未规定，现为段级整体覆盖，**请求核对**。
7. **项目配置写入的一致性前置条件**（P01-3 §9-8）：`stale_dependency` 与写时复检为实施值，
   **请求核对**。
8. **脱敏导出字段 Schema 与格式版本**（P01-3 §9-9）：设计未规定，现为
   `SETTINGS_EXPORT_FORMAT_VERSION=1` 白名单投影，**请求核对**。
9. **验收工具约定**（本阶段新增）：设计未规定 `accept:p01` 的报告位置、`run-id` 形态、
   `configVersion` 与检查 ID 集合；本契约为实施值，**请求核对**；若设计给出不同约定，应由
   显式变更同步本文、报告 Schema 与测试。

未列入的矛盾按「已有契约优先复用」处理；不得由实施任务静默改变领域语义。

---

## 9. 复核

- 基线：§1.3（`npm ci` 退出 0；`npm run verify` 退出 0，`PASS 3/3`；35 files / 700 tests）。
- 本文引用的真实常量/端口/迁移/前序测试入口由
  [docs-p01-4-acceptance-contract.test.ts](../test/docs-p01-4-acceptance-contract.test.ts)
  交叉核对，防止文档与实现漂移。
- 本 Feature 只交付验收约定与检查清单（文档 + 守护测试）；`accept:p01`、夹具、报告与阶段
  最终报告由 F-002 ~ F-010 交付。本轮不自动修改任何 Harness 配置；未验收平台、强 OS 沙箱与
  模型 Live 明确为 `not_run`/未支持。
