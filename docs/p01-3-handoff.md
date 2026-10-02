# P01-3 接口交接（P01-2 → P01-3）

- 来源阶段：P01-2（SQLite 原子存储与制品落盘），实现范围与证据见
  [acceptance/p01-2-f014-report.md](acceptance/p01-2-f014-report.md)。
- 交接对象：P01-3（应用服务 / 项目注册与配置合并等）及后续 Host/CLI 组合。
- 本文只交接**已实现并已验收**的端口与边界；未实现项明确标注，不代为实现。

## 1. 可复用端口与用例

P01-2 已交付、P01-3 可直接复用的接口（公共契约经 `shiploop-core` 入口导出，见
`packages/core/src/index.ts`）：

| 能力 | 端口 / 用例 | 关键入口 | 语义要点 |
|---|---|---|---|
| 项目与配置 | `StateStore` | `createProject` / `getProject` / `updateProject` / `createProjectWithInitialSettings` / `createGlobalSettings` / `getGlobalSettings` / `updateGlobalSettings` / `createProjectSettings` / `getProjectSettings` / `updateProjectSettings` | 稳定 ID、UTC 毫秒、`revision` CAS；全局单例、项目唯一；运行时校验；损坏 JSON 读取报 `corrupt` |
| 制品索引 | `ArtifactStore` | `registerArtifact` / `getArtifact` / `transitionArtifact` / `getArtifactInputRef` / `listArtifacts` | `pending→ready/failed` 单向终态；ready 内容身份不可覆盖；跨项目 `ownership` 拒绝；`listArtifacts` 只读有界分页 |
| 制品文件 | `ArtifactFileStore` | `resolvePlacement` / `openStagingWrite` / `finishStaging` / `publishStaging` / `discardStaging` / `openFinalRead` / `statFinal` / `scanFinalArea` / `scanStagingArea` | 受控逻辑定位、同文件系统 staging、不覆盖发布、路径逃逸拒绝、有界扫描不跟随链接 |
| 制品发布 | `ArtifactPublisher` | `createArtifactPublisher({ artifacts, files, limits })` → `publishArtifact` | 短事务登记、事务外流式写入/同步/hash 核验、不覆盖发布、CAS ready；失败保留阶段证据 |
| 中断核对 | `ArtifactVerifier` | `createArtifactVerifier({ artifacts, files, limits })` → `verifyArtifact` / `verifyProject` / `readVerifiedContent` | pending 恢复、三种 corrupt 诊断、孤儿 `kept_in_place`、有界批量核对 |
| 迁移执行 | `migrateSqliteStorage(session, options?)` | `adapters/sqlite/migrator.ts` | verify→backup→apply；高版本/checksum 漂移拒写；一致性备份 |
| 连接会话 | `openSqliteStorageSession(options)` | `adapters/sqlite/session.ts` | 固定 PRAGMA、短同步事务、有限 busy 预算、幂等 close |

结构化错误：

- `StorageError.kind` ∈ `validation` / `not_found` / `conflict` / `busy` / `corrupt` /
  `unsupported_version` / `ownership`（`ports/errors.ts`）。
- `ArtifactFileError.kind` ∈ `invalid_input` / `escape` / `conflict` / `not_found` /
  `not_regular_file` / `permission` / `io`（`ports/artifact-files.ts`）。
- `ArtifactPublishError.stage` ∈ `register` / `staging` / `verify` / `publish` / `commit`；
  `code` ∈ `validation` / `size_limit_exceeded` / `timeout` / `cancelled` / `stream` /
  `hash_mismatch` / `size_mismatch` / `storage` / `file`（`application/artifact-publish.ts`）。
- `ArtifactVerifyError.code` ∈ `validation` / `not_found` / `ownership` / `conflict` /
  `corrupt` / `storage` / `file` / `size_limit_exceeded`，损坏时携带 `ArtifactCorruption`
  （`application/artifact-verify.ts`）。

错误消息与 `details` 一律脱敏：不含绝对路径、凭据或正文内容；只含相对逻辑位置、摘要级数据与错误码。

## 2. 受控文件定位边界

- 物理位置**只**由授权数据根 + 稳定 `projectId` / `artifactId` 推导：
  `projects/<projectId>/artifacts/<artifactId>/content` 与 `staging/<projectId>/<artifactId>.<随机>.part`。
- `locator` 是索引中的**逻辑身份**，只校验与诊断，不参与物理路径；`displayName` / `description` /
  `kind` / 中文标题不能控制物理路径。
- 稳定 ID 受限字符集；绝对路径、`..` 穿越、反斜杠、NUL、空段一律 `validation`。
- 父目录符号链接逃逸在读写前经 `realpath` 拒绝；目标为符号链接经 `lstat`/`no-follow` 拒绝。
- 可信项目模式：检查与操作之间的并发替换窗口由「单 Host 写入者 + 用户明确授权的可信项目」前提收窄；
  **不宣称强 OS 沙箱**。要求强隔离的任务不应复用该假设。
- 制品发布采用 `link` 的 `EEXIST` 语义保证不覆盖，无检查-操作窗口。

## 3. 组合根与跨包边界（P01-3 需明确）

- **当前状态**：`shiploop-core` 的公共入口 `exports` 只暴露 `.`（`dist/index.js`），其中为
  ports 契约 + application 用例（无 I/O）；SQLite / 文件适配器位于 `packages/core/src/adapters/`，
  **不经 package `exports` 暴露**。契约区分层（domain/application/ports/公共入口）由
  `scripts/check-boundaries.ts` 强制**禁止导入 `adapters` 实现**。
- **待定**：Host 或 P01-3 应用服务如何取得已装配的 `StateStore` / `ArtifactStore` /
  `ArtifactFileStore` 实例（即组合根位置与形式）。当前仓库内测试与证据脚本以**相对源码路径**或
  **dist 相对文件路径**直接加载适配器；跨包发布路径尚未定义。P01-3 需在 Core 内确定受控装配入口
  （例如新增明确的子路径导出或 Core 内组合模块），并保持契约区不反向依赖 `adapters`。
- **不可绕过**：不得通过包内自引用（`shiploop-core/src/...`）、跨包内部相对路径或禁止的
  HTTP/DB 客户端绕过边界直连 SQLite/文件；`check:boundaries` 会拒绝。

## 4. 数据与迁移边界

- 已建表：`projects`、`repository_bindings`、`global_settings`、`project_settings`、`artifacts`、
  `schema_migrations`（共六张，字段与约束见验收报告 §5）。
- 迁移清单与记录位置：`packages/core/src/adapters/sqlite/migrations.ts` 的 `SQLITE_MIGRATIONS`
  （当前唯一版本 `version=1`，随构建产物分发为 `dist/adapters/sqlite/migrations.js`，可从 dist 定位）。
  执行记录写入 `schema_migrations`（`version` 唯一、`checksum`、`applied_at`）。
- 后续能力（执行域、Chat、知识等）**必须新增迁移版本**，不得保留占位表或为不存在的表建悬空外键。
  `source_attempt_id`、`retention_class` 等字段随对应功能迁移增加。
- `repository_bindings` 仅提供存储支撑（同项目复合外键 + `ON DELETE RESTRICT`），**不扫描仓库、不执行 Git**；
  仓库注册流程与绑定写入端口属 P01-3 及后续范围。

## 5. 交接给 P01-3 的验收前置

- P01-3 的应用服务应建立在本 Feature 已验收端口之上，继续遵守：输入一律运行时校验、
  破坏性操作走 CAS、终端状态不可覆盖、跨项目归属拒绝、错误脱敏。
- 新增能力不得通过删除测试、降低验收门槛或扩大权限使任务通过（Roadmap §3 纪律）。
- 配置合并 / 模型路由 / Task 策略复制 / 凭据解析 / 项目列表分页 / 注册流程当前**未实现**；
  P01-3 按其自身验收标准实现，不要在本阶段以「已完成」冒充。

## 6. 工程验证策略交接（不修改 executor/agent 配置）

- 仓库级默认验证：`npm test`（开发内循环）；`npm run verify`（锁文件预检 + `npm test` /
  `typecheck` / `build` 串联，fail-closed）。
- 建议 Harness 将本仓库 Feature 验证命令对齐为 `npm run verify`，以编排退出码作为通过依据。
- 本任务**未**自动修改任何 executor / agent / YAML 配置；以上仅供 Harness 侧确认。
