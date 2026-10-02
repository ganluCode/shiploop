# P01-4 / P02 接口交接（P01-3 → 后续阶段）

- 来源阶段：P01-3（项目身份与当前配置服务），实现范围与证据见
  [acceptance/p01-3-f014-report.md](acceptance/p01-3-f014-report.md)。
- 交接对象：**P01-4**（P01 持久化闭环验收，`2026-10-01-23-44-21_p01-4-p01`）与 **P02 / R1 之后
  的 CLI 与 Host 纵向闭环**（将 Core 命令/查询包装为版本化协议）。
- 本文只交接**已实现并已验收**的端口、用例与可复跑入口；未实现项明确标注，不代为实现。
- 平台边界：macOS 是 P01-3 唯一正式验收平台；Windows/WSL/Linux、强 OS 沙箱、模型 Live
  均为 `not_run` / 未支持。

## 1. P01-3 交付的可复用能力

已交付、后续阶段可直接复用的 Core 能力（公共契约经 `shiploop-core` 入口导出，装配经
`shiploop-core/assembly` 子路径）：

| 能力 | 端口 / 用例 | 关键入口 | 语义要点 |
|---|---|---|---|
| 组合根 | `openCoreApplication(options)` | `CoreApplication`（`dataRoot`/`pathService`/`stateStore`/`artifactStore`/`artifactFileStore`/`repositoryInspector`/`projectService`/`configurationService`/`close()`） | 选项校验先于任何 I/O；只创建数据根；执行版本化迁移；`close()` 幂等，关闭后同根重开 |
| 项目身份 | `ProjectService` | `registerRepository` / `getProject` / `getRepositoryBinding` / `updateProjectMetadata` / `listProjects` / `countProjectLabels` | 稳定 UUID、规范 `canonicalPath`、CAS `revision`、标签共用规范化、稳定 `id` 升序键集分页、项目层去重计数 |
| 仓库检查 | `RepositoryInspector` | `inspect(repositoryPath)` | 只读 Git/文件检查，独立 argv + 显式 cwd + 有限超时/输出上限；工作树根/符号链接/ linked worktree；拒绝子目录、裸仓库、`.git` 内部目录 |
| 当前配置 | `ConfigurationService` | `createSettings` / `updateSettings` / `getCurrentSettings` / `getEffectiveSettings` / `exportSettings` | insert-only 首次创建、CAS 更新、一致性视图 stale_dependency 前置条件、完整条目整体替换、政策段级覆盖、逐项来源、脱敏导出 |
| 有效配置合并 | `mergeEffectiveSettings(input)`（纯函数） | `application/effective-settings.ts` | 键级继承 + 完整条目整体替换 + 政策段级整体覆盖；无效来源不降级 |
| 路径 | `PathService` | `dataRoot()` / `databaseFilePath()` / `projectDirectory(projectId)` / `locateProjectResource(scope, resource)` | 稳定 `dataNamespace="shiploop"`、`core.sqlite`、受权定位（存在性 + 归属核验）、符号链接逃逸拒绝 |
| 能力目录 | `RuntimeCapabilityCatalog` / `assessSettingsConfiguration` | `ports/runtime-capabilities.ts` | 可信装配注入的窄能力描述；未知 runtime/provider/model 带字段定位拒绝；`executable` 恒 false（未装配执行能力） |
| 存储底座（前序） | `StateStore` / `ArtifactStore` / `ArtifactFileStore` / `migrateSqliteStorage` | `packages/core/src/adapters/sqlite/*`、`adapters/fs/*` | 复用前序端口，P01-3 新增迁移 v2（`state_events`） |

结构化错误：`StorageError.kind` ∈ `validation` / `not_found` / `conflict` / `busy` / `corrupt` /
`unsupported_version` / `ownership`；仓库/路径检查的窄错误（`RepositoryInspectionError`、
`PathResolutionError`）同样携带 `operation` 与脱敏 `details`。

### 1.1 数据与迁移

- 已建表：`projects`、`repository_bindings`、`global_settings`、`project_settings`、`artifacts`、
  `schema_migrations`（v1 六表）+ `state_events`（v2 审计）。
- 迁移清单：`packages/core/src/adapters/sqlite/migrations.ts` 的 `SQLITE_MIGRATIONS`
  （`version=1` 六表、`version=2` `state_events`），执行记录写入 `schema_migrations`。
- `state_events.project_id` 可空并带 CHECK（仅 `aggregate_type='global_settings'` 允许空），
  为对设计 11 §9 字典的显式偏离，依据与核对请求见
  [p01-3-application-contract.md §6.3 / §9-1](p01-3-application-contract.md)。
- 后续能力（执行域、Chat、知识等）**必须新增迁移版本**，不得保留占位表或建悬空外键。

## 2. 交接 P01-4：可复跑持久化闭环与失败注入入口

P01-4 需运行真实持久化闭环并保存失败前后状态。以下入口已交付且可独立执行，建议直接复用，
不必重建夹具或复制 SQL。

### 2.1 可复跑持久化闭环

| 入口 | 用途 | 证据/断言 |
|---|---|---|
| `test/p01-3-fr-acceptance-closed-loop.test.ts`「闭环」用例 | 组合根集成闭环：注册（稳定 projectId/绑定/规范标签）→ 全局/项目配置创建与 CAS 更新 → `ArtifactStore` 制品发布 → 元数据编辑 → 有效配置来源 → 脱敏导出 → 受权定位 → 关闭重开逐字段一致 | 真实行级证据（`projects`/`repository_bindings`/`global_settings`/`project_settings`/`artifacts` 各一条、恰三条脱敏 `state_events`）；源仓库指纹（全部文件内容 + HEAD + status）闭环前后逐字节不变 |
| `examples/p01-3-standalone.ts` | 可编译独立示例：`打开 → 注册 → 查询 → CAS 编辑 → 全局/项目配置 → 有效配置来源 → 脱敏导出 → 受权定位 → 关闭重开` | 由 `test/core-assembly.test.ts` 在真实临时仓库/数据根上执行，返回可断言摘要 |
| `scripts/core-assembly-smoke.mjs` | 构建产物冒烟：非源码 cwd 下从 dist 加载 `shiploop-core/assembly` 执行装配/注册/配置/受权定位/制品发布/关闭重开 | 由 `scripts/smoke-built-entries.ts` 在 `npm run build` 中编排；P01-4 F-009 另由 `test/p01-4-build-smoke.test.ts` 在临时编译产物上运行同一冒烟并做路径/依赖/迁移扫描，断言不写用户目录 |
| `test/helpers/git-repo.ts` + `test/helpers/temp-sandbox.ts` | 真实临时 Git 仓库/数据根夹具；缺失工具即失败不 skip；清理前可导出证据 | 幂等清理，拒绝用户仓库/HOME/符号链接逃逸 |

`openCoreApplication` 的 `nowUtcMs` 可注入以获得确定性时间；`dataRoot` 与 `repositoryPath` 由
调用方在临时沙箱内显式提供，不读写真实用户目录。

### 2.2 失败注入入口

| 失败分支 | 入口 | 断言 |
|---|---|---|
| 项目+绑定统一回滚 | `test/project-registration.test.ts`（注入绑定写失败的 TEMP TRIGGER） | 项目与绑定均不存在，零残留 |
| 元数据/配置审计注入回滚 | `test/project-metadata-service.test.ts`、`test/configuration-service.test.ts`、`test/p01-3-fr-acceptance-closed-loop.test.ts`（同一连接 `CREATE TEMP TRIGGER` on `state_events`） | 实体写入与 `revision` 一并回滚；修复后可继续 |
| 跨进程注册竞争 | `test/helpers/register-race-child.ts`（同步屏障、有限超时、退出核验） | 恰一 `registered`、一 `already_exists`，仅一项目一绑定 |
| 跨进程配置 CAS 竞争 | `test/helpers/settings-race-child.ts`、`test/helpers/cas-race-child.ts` | 同旧 revision 恰一胜者，revision 仅增一次，值等于胜者 |
| 制品发布中断 | `test/helpers/interrupt-publish-child.ts`、`test/artifact-verify.test.ts` | 重开后 pending 只有 hash/size 匹配才补 ready；孤儿保留原位 |

失败注入使用真实 SQLite / 真实 Git / 真实文件，不以 mock 次数或成功日志替代副作用断言；
子进程竞争均带同步屏障、有限外层超时与退出核验。

### 2.3 P01-4 边界提醒

- `npm run verify` 是**工程检查编排**，不是业务 Verifier；P01-4 需另建 `accept:p01`（本阶段
  未提供）。
- P01-4 的阶段报告需区分 P01 已实现子集与后续未实现项：T03（存储原子性/竞争子集）、
  T26（当前配置 CAS 基础）、T32（项目标签）、T24（默认/完整策略与来源基础）；不得冒充认领、
  活动执行锁或 Task 策略复制完整验收。
- 验收限 macOS；正式验收命令应在无 `node_modules`/`dist` 残留的干净源码快照中重新 `npm ci`
  后执行，Live 未运行记为 `not_run`。

## 3. 交接 P02 / R1：可包装的命令 / 查询契约

P02（CLI 与 Host 纵向闭环）可将下列 Core 用例包装为**版本化命令/查询协议**；具体路由与 CLI
参数在对应接口实现阶段确定（本阶段无 Host 网络接口、无 CLI 命令）。

### 3.1 命令（写）

| 命令 | 输入 | 输出 | 失败形态 |
|---|---|---|---|
| `registerRepository` | `{ repositoryPath, displayName, description?, labels? }` | `{ status: 'registered' \| 'already_exists', project, binding }` | `validation`（先于 I/O）、`RepositoryInspectionError`、`StorageError` |
| `updateProjectMetadata` | `projectId` + `{ expectedRevision, displayName?, description?, labels? }` | `ProjectRecord`（`revision` 递增） | `not_found`、`conflict`、`validation` |
| `createSettings` | `scope` + `{ payload }` | `SettingsWriteResult`（`revision=1`） | `validation`、`not_found`、`conflict` |
| `updateSettings` | `scope` + `{ expectedRevision, payload }` | `SettingsWriteResult`（`revision` 递增） | `validation`、`not_found`、`conflict`（含 `stale_dependency`）、能力拒绝 |

### 3.2 查询（读）

| 查询 | 输入 | 输出 |
|---|---|---|
| `getProject` / `getRepositoryBinding` | `projectId` | `ProjectRecord` / `RepositoryBindingRecord` |
| `listProjects` | `{ match?, labels?, limit?, cursor? }` | `{ records, nextCursor }` |
| `countProjectLabels` | — | `{ label, projectCount }[]` |
| `getCurrentSettings` | `scope` | `{ schemaVersion, payload, revision }` |
| `getEffectiveSettings` | `projectId` | `EffectiveSettings`（精确值 + 逐项来源；`configured:false` 表示未配置） |
| `exportSettings` | `projectId?` | `ExportedSettings`（脱敏，不含 executable/ready） |
| `locateProjectResource` | `scope` + `resource` | `LocatedPath`（`projectId`/`resourceType`/`relativePath`/`absolutePath`） |

包装注意：

- 命令/查询的**目标身份只来自 `scope` 或显式 `projectId`**；Host/CLI 不得自行声明
  `consistency`，也不得仅凭传入 `projectId` 授权资源定位。
- `credentialRef` / `endpointRef` 只传引用字符串；协议层不得读取或回传明文秘密/环境值。
- `exportSettings` 是普通脱敏导出，**不是**执行就绪证明；不要因结构合法而将项目标为可运行。
- 查询为只读、无副作用；命令失败时协议层不得把回滚后的旧值/日志当作新状态。

## 4. 明确未交付 / 不属本交接

- **Host 网络接口（HTTP/SSE）与认证**：未实现。
- **CLI 命令与参数解析**：未实现（不编造 `shiploop` 命令）。
- **Runtime 执行 / Pi SDK / 模型调用**：未实现。
- **Task 策略复制**（`tasks.execution_config`）、执行表（Phase/Feature/Task/Run/Attempt/Batch/
  Session）、DAG 调度：未实现。
- **rebind / 源代码迁移 / 存量基线扫描 / 配置历史版本表**：未实现。
- Windows / WSL / Linux 验收、强 OS 沙箱、模型 Live：`not_run` / 未支持。

## 5. 工程验证策略交接（不修改 executor/agent 配置）

- 仓库级默认验证：`npm test`（开发内循环）；`npm run verify`（锁文件预检 + `npm test` /
  `typecheck` / `build` 串联，fail-closed）。
- 建议 Harness 将本仓库 Feature 验证命令对齐为 `npm run verify`，以编排退出码作为通过依据。
- 本任务**未**自动修改任何 executor / agent / YAML 配置；以上仅供 Harness 侧确认。负向验收
  纪律（不得通过删测试、降低门槛或扩大权限恢复）见验收报告。
