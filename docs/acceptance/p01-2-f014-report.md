# P01-2 Feature 验收报告（F-014）

- 验收日期：2026-10-02
- 验收平台：macOS 26.6.2（arm64），Node `22.19.0` / npm `10.9.3`
- 受测代码 commit：`5bf878c850ccf98d3a27c8730f38265a2e4540e7`（分支
  `feat/2026-10-01-23-44-21_p01-2-sqlite`，F-013 提交；本报告与配套文档在其后作为 F-014
  文档提交，不改变受测代码）
- 范围界定：本报告是 **P01-2 存储与制品落盘**的 Feature 验收，**不是** P01 阶段验收，也不提供
  `accept:p01`。结论均来自真实命令退出码与可核对证据；不以 Nezha/Harness 的 completed 状态代替
  代码验收。

## 1. 输入文档版本

设计输入为 Harness 知识目录 `architecture-redesign/`（非本仓库，以内容哈希固化版本）。本 Feature
实际依据的主要文档及其 SHA-256：

| 文档 | SHA-256 |
|---|---|
| `08-migration-roadmap.md` | `c6f527bd0846e805189b6ea8369cedb90442f6254198a3216dc3600c3d9c04a6` |
| `core-design/03-storage-and-transactions.md` | `c393f95c96d62c9ec708e3043fde78194c85acea2ea1dad6924b31fd83f7183d` |
| `core-design/11-database-model.md` | `57dc3c6eab520fea43b5078a131821525f5c85336c09990719f10f9b705e5fa9` |
| `core-design/02-domain-and-lifecycle.md` | `6fabe0e602e2e22667a9cf3e37c0b9b85049e96a1b51d7cf4876e18096f65f99` |
| `core-design/07-verification-and-delivery.md` | `0bad1d917e9148d587924dfdd6c1901dd8cce6df159fe7a0a2c408c9ae3c11da` |
| `core-design/09-testing-and-implementation.md`（S2 实验基线） | `ef923b34ecc5a81b82c60f13102184617765f2c1dd5b5acff1228370e297a0c8` |
| `core-design/10-repository-and-release.md` | `1149abf7b88370e74867501fd412593a7f5847ac58de7fc8a673e5ed4b0edf06` |
| `core-design/01-system-structure.md` | `1f66552a4e7e7b83c81f33138fbe81d5d9e4e5d9cb6ae5b69b92766e143c7490` |

## 2. 实现范围（F-001 ~ F-013）

- **F-001**：Core 适配层固定 `better-sqlite3@13.0.3`、`drizzle-orm@0.45.3`（`@types/better-sqlite3@9.6.0`），
  真实临时 SQLite 测试夹具，macOS `darwin-arm64` 原生模块加载（SQLite 3.53.4）。
- **F-002**：最小 `StateStore` / `ArtifactStore` 窄契约、`schemaVersion=1` 限定配置 Schema、
  运行时校验与结构化错误；公共契约不依赖 Pi/HTTP/Electron/Drizzle/better-sqlite3。
- **F-003**：Drizzle Schema 与版本化迁移（六表：`projects`、`repository_bindings`、
  `global_settings`、`project_settings`、`artifacts`、`schema_migrations`）。
- **F-004**：连接生命周期、固定 PRAGMA 策略、短同步 `BEGIN IMMEDIATE` 事务、有限 busy 预算。
- **F-005**：带校验记录迁移、高版本/checksum 漂移拒写、失败回滚证据、升级前一致性备份与恢复演练。
- **F-006**：项目与全局/项目当前配置的创建与读取（读取路径重校验，损坏 JSON 以 `corrupt` 拒绝）。
- **F-007**：`expectedRevision` CAS、原子组合创建、真实跨进程竞争与失败注入回滚。
- **F-008**：外键/项目归属/DDL 约束回归矩阵（同项目复合外键补齐；绕过端口的非法 SQL 亦被拒绝）。
- **F-009**：制品索引 pending 登记、CAS 状态转换与有效输入引用（跨项目 `ownership` 拒绝）。
- **F-010**：制品文件适配器——受控逻辑定位、同文件系统 staging、不覆盖发布、路径逃逸防护、有界扫描。
- **F-011**：制品流式发布编排（短事务登记、事务外写 staging/核验/发布、CAS 标 ready；有限限制）。
- **F-012**：关闭重开后中断核对、三种 corrupt 诊断、孤儿 `kept_in_place` 证据与有效读取。
- **F-013**：全链路集成闭环 + 故障回归清单守护 + 干净快照六步验收证据。
- **F-014**（本报告）：存储操作与恢复说明、Feature 验收报告、P01-3 接口交接与文档示例编译/运行核验。

## 3. 环境与版本

| 项 | 值 |
|---|---|
| 平台 | macOS 26.6.2（arm64） |
| Node.js | `22.19.0` |
| npm | `10.9.3` |
| SQLite（驱动查询） | `3.53.4` |
| better-sqlite3 | `13.0.3`（精确锁定） |
| drizzle-orm | `0.45.3`（精确锁定） |
| 测试运行器 | Vitest `5.0.3` |

环境记录证据：[`evidence-p01-2/00-environment.log`](evidence-p01-2/00-environment.log)。

## 4. 正向验收

### 4.1 F-013 干净快照六命令（受测实现 commit `5bf878c`）

快照为仓库工作区 tar 拷贝到系统临时目录（排除 `node_modules` / `.git` / `packages/*/dist`），
在无源码 cwd 的 `/tmp` 下执行。命令、退出码、耗时记录于
[`evidence-p01-2/00-commands.log`](evidence-p01-2/00-commands.log)。此快照早于 F-014 新增的文档示例核验测试，测试计数为 441 passed / 19 文件。

| # | 命令 | 退出码 | 证据 |
|---|---|---|---|
| 1 | `npm ci` | 0 | [01-npm-ci.log](evidence-p01-2/01-npm-ci.log) / [.exit](evidence-p01-2/01-npm-ci.exit) |
| 2 | `npm test` | 0（441 passed，19 文件） | [02-npm-test.log](evidence-p01-2/02-npm-test.log) / [.exit](evidence-p01-2/02-npm-test.exit) |
| 3 | `npm run typecheck` | 0 | [03-typecheck.log](evidence-p01-2/03-typecheck.log) / [.exit](evidence-p01-2/03-typecheck.exit) |
| 4 | `npm run build` | 0（三入口冒烟 ok） | [04-build.log](evidence-p01-2/04-build.log) / [.exit](evidence-p01-2/04-build.exit) |
| 5 | `npm run verify` | 0（`PASS 3/3`） | [05-verify.log](evidence-p01-2/05-verify.log) / [.exit](evidence-p01-2/05-verify.exit) |
| 6 | dist 非源码 cwd 存储闭环 | 0 | [06-dist-closed-loop.log](evidence-p01-2/06-dist-closed-loop.log) / [.exit](evidence-p01-2/06-dist-closed-loop.exit) / [脚本](evidence-p01-2/06-dist-closed-loop.mjs) |

第 6 步在 `cwd=/tmp`（源码树之外）从快照构建产物 `packages/core/dist` 运行：迁移模块从 dist 定位 →
迁移 → 组合创建项目+配置 → 发布制品（hash/size 核验）→ CAS 更新 → 关闭重开 → ID/revision/JSON/hash/size
逐字段一致 → `verifyProject` 全 `verified_ready`、无孤儿 → 迁移记录仍在，退出 0。证明构建产物不依赖源码
cwd 或开发机路径。证据已脱敏（`<SNAPSHOT-ROOT>` / `<HOME>` / `<TMPDIR>`）。

### 4.2 F-014 文档示例核验与工作区回归

- 文档示例（[storage-operations.md §3](../storage-operations.md)）与
  [`test/sqlite-storage-integration.test.ts`](../../test/sqlite-storage-integration.test.ts)
  的全链路闭环同构；
- 新增 [`test/docs-storage-operations.test.ts`](../../test/docs-storage-operations.test.ts)
  以真实适配器编译并运行该最小示例，断言文档所述状态机、busy 预算与受控 locator；
- F-014 工作区回归：`npm test` → 0（443 passed，20 文件，含文档示例核验 2 用例）；
  `npm run verify` → 0（`PASS 3/3`）。证据
  [07-f014-workspace-verify.log](evidence-p01-2/07-f014-workspace-verify.log) /
  [.exit](evidence-p01-2/07-f014-workspace-verify.exit)；
- 文档中不存在未提供的 CLI 命令（本阶段无 CLI）。

## 5. 已实现表 / 字段 / 约束与迁移记录

迁移定义：`packages/core/src/adapters/sqlite/migrations.ts`（`SQLITE_MIGRATIONS`，当前唯一
`version=1`，随构建产物分发为 `dist/adapters/sqlite/migrations.js`）。执行记录写入
`schema_migrations`（`version` 唯一递增、`checksum` 为 SQL 内容 SHA-256、`applied_at` UTC 毫秒）。
Drizzle Schema 交叉核对见 [`test/sqlite-schema-migrations.test.ts`](../../test/sqlite-schema-migrations.test.ts)。

| 表 | 关键字段 | 关键约束 |
|---|---|---|
| `projects` | `id` PK、`created_at`、`revision`、`updated_at`、`display_name`、`status`、`description`、`labels`、`repository_binding_id` | `revision ≥ 1`；`display_name` 非空；`status ∈ active/archiving/archived/deleting`；`labels` 为 JSON 数组；`repository_binding_id → repository_bindings.id`（`RESTRICT`）+ 同项目复合外键 `(id, repository_binding_id) → repository_bindings(project_id, id)`（`RESTRICT`） |
| `repository_bindings` | `id` PK、`project_id`、`canonical_path`、`git_common_dir`、`repo_identity`、`binding_revision` | `canonical_path` 全库唯一且非空；`repo_identity` 非空；`binding_revision ≥ 1`；`project_id → projects.id`（`RESTRICT`）；`UNIQUE(project_id, id)` |
| `global_settings` | `id` PK、`schema_version`、`payload`、`revision` | `CHECK id='global'`（单例）；`schema_version ≥ 1`；`payload` 为合法 JSON |
| `project_settings` | `id` PK、`project_id`、`schema_version`、`payload`、`revision` | 每项目一条 `UNIQUE(project_id)`；`project_id → projects.id`（`RESTRICT`）；`schema_version ≥ 1`；`payload` 为合法 JSON |
| `artifacts` | `id` PK、`project_id`、`kind`、`status`、`media_type`、`expected_hash`、`content_hash`、`size_bytes`、`version`、`storage_locator`、`failure_reason` | `status ∈ pending/ready/failed`；`expected_hash`/`content_hash` 为 64 位小写 hex；`size_bytes ≥ 0`；`version ≥ 1`；`status='ready'` 必须携带 `content_hash`+`size_bytes`；`project_id → projects.id`（`RESTRICT`）；索引 `(project_id, status)` |
| `schema_migrations` | `id` PK、`version`、`checksum`、`applied_at` | `version ≥ 1` 且唯一；`checksum` 为 64 位小写 hex |

- **外键删除策略**：全部 `ON DELETE RESTRICT`，迁移 DDL 不含 `CASCADE`；不通过数据库级级联删除用户源仓库或正文文件。
- **未建字段**：`artifacts.source_attempt_id`（`attempts` 表属后续迁移，禁止悬空外键）、
  `artifacts.retention_class`（取值无设计结论，随保留策略设计加入）。
- **迁移记录位置**：`schema_migrations` 表（无 `project_id`，全局表）。

### 5.1 备份边界

- 升级前一致性备份由 `better-sqlite3` 的 SQLite 在线备份 API 生成，备份后以只读连接运行
  `integrity_check` 核验；备份失败不开始迁移，备份文件不删除、不覆盖既有目标。
- **备份只覆盖 SQLite 状态库，不包含受控文件根中的制品正文。** 数据库备份 ≠ 含制品正文的全量备份；
  正文证据需另行核对（`ArtifactVerifier`），当前**未声明全量恢复能力**。
- 恢复演练（复制备份到独立库并读到升级前一致数据）见
  [`test/sqlite-migration-runner.test.ts`](../../test/sqlite-migration-runner.test.ts)。

## 6. 已建能力之外的明确边界

- **未建表**：Phase / Feature / Task / Run / Attempt / Batch / Session / Chat / 知识 / 记忆 /
  通知 / 审批等执行与协作表，以及 `project_profiles`、`capability_modules`、
  `verification_batches`、`check_results` 等；本 Feature 只建上述六张。
- **未做**：仓库注册流程、`PathService` 默认 OS 数据根解析、配置有效合并 / 模型路由 / 凭据解析、
  Task 策略复制、配置历史版本表、项目列表分页、标签统计筛选、Host/CLI 命令。
- **未做**：统一迁移编排与 Host 停机升级、自动降级、桌面原生模块打包。
- **孤儿处置**：`kept_in_place`（保留原位置，不立即删除未知文件、不自动绑定跨项目）；安全隔离迁移待保留策略设计。

## 7. 已知缺口与 not_run（不以注入或冒充折算通过）

| 项目 | 状态 |
|---|---|
| 真实断电 / 磁盘满演练（ENOSPC 等为**显式注入**故障，非真实磁盘满） | not_run |
| Windows / WSL / Linux 平台验收 | not_run（macOS 是唯一正式验收平台） |
| Electron 原生模块打包与升级 | not_run |
| 真实跨文件系统 EXDEV 演练（以结构性同根 + dev 复核替代，未挂载真实异盘） | not_run |
| Host 停机升级编排与自动降级 | not_run |
| 孤儿文件安全隔离迁移（当前 `kept_in_place`） | not_run |
| T24 Task 策略复制、T32 完整标签查询、项目列表分页、仓库注册 | not_run（后续 Feature） |
| Host / CLI 命令、`accept:p01` 阶段验收 | not_run（本阶段 verify 仅为开发工程检查） |
| 模型 Live 调用（Pi SDK 未安装、未调用） | not_run |
| 全量恢复（数据库 + 制品正文） | not_run（当前仅数据库级备份与正文核对，不宣称全量） |

## 8. Harness 验证策略交接（本任务不修改 executor/agent 配置）

- 仓库级默认验证为 `npm test`（开发内循环）；`npm run verify`（锁文件预检 + `npm test` /
  `typecheck` / `build` 串联，fail-closed）为工程检查编排。
- 建议 Harness 将本仓库 Feature 验证命令对齐为 `npm run verify`，以编排退出码作为通过依据。
- 本任务**未**自动修改任何 executor / agent / YAML 配置；负向验收纪律（不得通过删测试、降低门槛
  或扩大权限恢复）记录于交接文档。

## 9. 结论

P01-2 在 macOS 干净快照上的六条命令（`npm ci` / `npm test` / `npm run typecheck` /
`npm run build` / `npm run verify` / dist 非源码 cwd 闭环）真实退出码全部为 0（F-013 快照
441 passed，19 文件）；F-014 新增文档示例核验后工作区 `npm test` 443 passed / 20 文件、
`npm run verify` 仍返回 0，套件内无 skip；文档示例由闭环测试与编译检查核验；源码、产物与证据
无开发机绝对路径依赖、无凭据、未执行 npm 发布。本结论仅限上述 P01-2 存储与制品落盘范围，
不代表 P01 阶段验收或任何业务 Live 验收通过。
