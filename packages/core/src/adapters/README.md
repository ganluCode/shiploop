# Core · adapters

适配器层：端口的具体实现（sqlite、文件、git、pi 等），只在装配入口被连接。

- 允许：实现 `ports` 接口；依赖 `application`/`domain` 类型；在正式接入该能力的 Feature 引入对应第三方依赖（如 Pi SDK、better-sqlite3 + Drizzle）。
- 禁止：被 `domain`、`application`、`ports` 或公共入口直接导入；在本阶段为占位而安装或模拟 Pi、Electron、HTTP 框架；适配器写业务数据库或接管 Task 调度。

当前阶段（P01-2 / F-006）：`shiploop-core` 已在适配层固定安装 `better-sqlite3@13.0.3` 与 `drizzle-orm@0.45.3`（含 `@types/better-sqlite3@9.6.0`），驱动与 ORM 的引用只允许出现在本层及装配入口（由 `scripts/check-boundaries.ts` 与 `test/typescript-build.test.ts` 强制）。`sqlite/connection.ts` 为显式位置打开、幂等关闭的最小装配；`sqlite/schema.ts` 与 `sqlite/migrations.ts` 声明 F-003 的六表 Drizzle Schema 与版本化迁移内容（F-006 起新增迁移 v2 的 `state_events` 审计表）；`sqlite/session.ts` 提供 F-004 的连接生命周期（固定 PRAGMA 策略：foreign_keys=ON、WAL、synchronous=FULL、显式 busy_timeout，打开时核验）、短同步写事务（BEGIN IMMEDIATE，拒绝 async/Promise 回调）与有限 busy 预算重试（耗尽后返回 StorageError kind='busy'）；`sqlite/migrator.ts` 实现 F-005 的带校验记录迁移、高版本拒写与升级前一致性备份。`sqlite/state-store.ts` 实现 F-006 的 StateStore 端口（项目与全局/项目当前配置的创建、读取与 expectedRevision CAS 更新；写入前/读取时经 F-002 运行时校验，损坏 JSON 以 corrupt 拒绝）。跨进程竞争、失败注入与组合写入由 F-007 深入验证；制品索引由 F-009 起实现。Pi 适配器仍不在本阶段安装。

P01-3 / F-003 起新增 `fs/path-service.ts`：统一 PathService 的真实文件系统实现——显式/注入用户目录解析授权数据根（构造时 realpath 固定、只使用已存在根、不创建目录、不读取进程真实用户目录），`core.sqlite` 与 `projects/<id>` 受控定位，受权定位经注入的项目存在性核验端口（StateStore.getProject）核验存在与项目归属，沿用 realpath/祖先核对/no-follow 三层防线。

P01-3 / F-004 起新增 `fs/repository-inspector.ts`：只读仓库路径检查的真实 Git 实现——execFile 独立 argv + 显式 cwd + 有限超时与输出上限（不拼接 shell），最小确定子进程环境（GIT_CONFIG_NOSYSTEM/GLOBAL/SYSTEM 隔离机器配置、GIT_TERMINAL_PROMPT=0、GIT_OPTIONAL_LOCKS=0 保证只读），canonicalPath/gitCommonDir 经实际 Git 解析并 realpath 规范化，repoIdentity 为 gitCommonDir 的 SHA-256 派生（remote 不参与身份）；拒绝子目录/裸仓库/非 Git 目录，错误脱敏（reason 码 + 退出码/信号，无绝对路径与 stderr 原文）；不接触存储端口，Git/文件检查发生在数据库写事务之外。

P01-3 / F-005 起 `sqlite/state-store.ts` 扩展仓库绑定读写：`createProjectWithRepositoryBinding` 把项目与绑定封装为同一业务原子操作——两个输入在任何 SQL 之前完成运行时校验；`BEGIN IMMEDIATE` 下按 `canonical_path` 检查并插入（同路径/符号链接别名复用既有项目与绑定返回 already_exists，不新增行、不覆盖既有元数据；同 remote 不同 clone 分别注册）；唯一约束冲突时事务整体回滚后有界核对一次，不遗留孤立项目或绑定；`projects.repository_binding_id` 同事务回写（同项目复合外键由 DDL 强制）。`getRepositoryBinding` 按项目读取绑定（项目缺失/无绑定均为 not_found）。跨进程注册竞争、绑定写入失败注入回滚与端口级校验由 test/project-registration.test.ts 验证（真实临时 Git 仓库 + 真实临时 SQLite）。

P01-3 / F-006 起 `sqlite/state-store.ts` 的 `updateProject` 在同一 BEGIN IMMEDIATE 事务内完成
CAS 更新并追加一条 `state_events`（`project.metadata_updated`、项目/写后 revision 身份、
只含变更字段名的脱敏 payload，sequence 数据库内单调分配）；注入记录写入失败时元数据与 revision
一并回滚；`schema.ts`/`migrations.ts` 新增迁移 v2 建立 `state_events`（project_id 可空 + CHECK
限定仅 global_settings 可为空，唯一 sequence 索引）。审计原子性与查询/编辑闭环由
test/project-metadata-service.test.ts 与 test/sqlite-schema-migrations.test.ts 验证。

P01-3 / F-007 起 `sqlite/state-store.ts` 补充只读查询：`listProjects` 以绑定参数 + `json_each`
实现任一（`EXISTS`）/全部（命中计数等于请求数）标签筛选，稳定 `id` 升序键集分页（游标 = 上一页
最后一条 id，`LIMIT ?+1` 判定下一页）；`countProjectLabels` 以 `COUNT(DISTINCT projects.id)`
按项目去重计数并按标签升序返回。两查询无新表、无新迁移，标签不拼接 SQL（含元字符不注入），
由 test/project-tag-filter.test.ts（真实临时 SQLite）与 test/storage-contracts.test.ts 验证。

P01-3 / F-010 起 `sqlite/state-store.ts` 的配置写入扩展：`updateGlobalSettings`/`updateProjectSettings` 在 CAS 成功后的同一 BEGIN IMMEDIATE 事务内追加 `state_events` 审计记录（`settings.global_updated`/`settings.project_updated`，全局范围 project_id=NULL 由 CHECK 限定，payload 为 `settingsChangeSummary` 脱敏摘要）；注入记录写入失败时配置与 revision 一并回滚。`createProjectSettings`/`updateProjectSettings` 接受可选 `consistency.globalRevision` 一致性前置条件，在同一写事务内核对全局当前配置 revision（BEGIN IMMEDIATE 下无检查-提交窗口），不一致返回 conflict（stale_dependency），不提交基于陈旧依赖校验过的写入。跨进程全局/项目配置 CAS 竞争、陈旧依赖拒绝、审计原子性与脱敏由 test/configuration-service.test.ts 验证（真实临时 SQLite + 同步屏障子进程）。

P01-3 / F-012 起新增 `adapters/composition.ts`（受控装配公共入口）：`openCoreApplication` 在同一受控数据根内解析根、打开状态库并执行版本化迁移，再装配 StateStore/ArtifactStore/ArtifactFileStore/PathService/RepositoryInspector/ProjectService/ConfigurationService，返回只含窄端口与用例接口的 `CoreApplication`（不含会话/驱动/ORM 类型）与幂等 `close()`。该模块经 `shiploop-core` 包清单的 `./assembly` 子路径导出；跨包只允许依赖此已声明子路径，契约区仍不反向导入 adapters。构建产物冒烟由 `scripts/core-assembly-smoke.mjs` 在非源码 cwd 下从 dist 加载并执行，经 `scripts/smoke-built-entries.ts` 在 `npm run build` 中编排。
