# Core · adapters

适配器层：端口的具体实现（sqlite、文件、git、pi 等），只在装配入口被连接。

- 允许：实现 `ports` 接口；依赖 `application`/`domain` 类型；在正式接入该能力的 Feature 引入对应第三方依赖（如 Pi SDK、better-sqlite3 + Drizzle）。
- 禁止：被 `domain`、`application`、`ports` 或公共入口直接导入；在本阶段为占位而安装或模拟 Pi、Electron、HTTP 框架；适配器写业务数据库或接管 Task 调度。

当前阶段（P01-2 / F-006）：`shiploop-core` 已在适配层固定安装 `better-sqlite3@13.0.3` 与 `drizzle-orm@0.45.3`（含 `@types/better-sqlite3@9.6.0`），驱动与 ORM 的引用只允许出现在本层及装配入口（由 `scripts/check-boundaries.ts` 与 `test/typescript-build.test.ts` 强制）。`sqlite/connection.ts` 为显式位置打开、幂等关闭的最小装配；`sqlite/schema.ts` 与 `sqlite/migrations.ts` 声明 F-003 的六表 Drizzle Schema 与版本化迁移内容；`sqlite/session.ts` 提供 F-004 的连接生命周期（固定 PRAGMA 策略：foreign_keys=ON、WAL、synchronous=FULL、显式 busy_timeout，打开时核验）、短同步写事务（BEGIN IMMEDIATE，拒绝 async/Promise 回调）与有限 busy 预算重试（耗尽后返回 StorageError kind='busy'）；`sqlite/migrator.ts` 实现 F-005 的带校验记录迁移、高版本拒写与升级前一致性备份。`sqlite/state-store.ts` 实现 F-006 的 StateStore 端口（项目与全局/项目当前配置的创建、读取与 expectedRevision CAS 更新；写入前/读取时经 F-002 运行时校验，损坏 JSON 以 corrupt 拒绝）。跨进程竞争、失败注入与组合写入由 F-007 深入验证；制品索引由 F-009 起实现。Pi 适配器仍不在本阶段安装。

P01-3 / F-003 起新增 `fs/path-service.ts`：统一 PathService 的真实文件系统实现——显式/注入用户目录解析授权数据根（构造时 realpath 固定、只使用已存在根、不创建目录、不读取进程真实用户目录），`core.sqlite` 与 `projects/<id>` 受控定位，受权定位经注入的项目存在性核验端口（StateStore.getProject）核验存在与项目归属，沿用 realpath/祖先核对/no-follow 三层防线。
