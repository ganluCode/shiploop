# Core · adapters

适配器层：端口的具体实现（sqlite、文件、git、pi 等），只在装配入口被连接。

- 允许：实现 `ports` 接口；依赖 `application`/`domain` 类型；在正式接入该能力的 Feature 引入对应第三方依赖（如 Pi SDK、better-sqlite3 + Drizzle）。
- 禁止：被 `domain`、`application`、`ports` 或公共入口直接导入；在本阶段为占位而安装或模拟 Pi、Electron、HTTP 框架；适配器写业务数据库或接管 Task 调度。

当前阶段（P01-2 / F-004）：`shiploop-core` 已在适配层固定安装 `better-sqlite3@13.0.3` 与 `drizzle-orm@0.45.3`（含 `@types/better-sqlite3@9.6.0`），驱动与 ORM 的引用只允许出现在本层及装配入口（由 `scripts/check-boundaries.ts` 与 `test/typescript-build.test.ts` 强制）。`sqlite/connection.ts` 为显式位置打开、幂等关闭的最小装配；`sqlite/schema.ts` 与 `sqlite/migrations.ts` 声明 F-003 的六表 Drizzle Schema 与版本化迁移内容；`sqlite/session.ts` 提供 F-004 的连接生命周期（固定 PRAGMA 策略：foreign_keys=ON、WAL、synchronous=FULL、显式 busy_timeout，打开时核验）、短同步写事务（BEGIN IMMEDIATE，拒绝 async/Promise 回调）与有限 busy 预算重试（耗尽后返回 StorageError kind='busy'）。迁移执行/备份/高版本拒写由 F-005 实现；存储端口实现由 F-006 起实现。Pi 适配器仍不在本阶段安装。
