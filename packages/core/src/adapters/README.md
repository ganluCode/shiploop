# Core · adapters

适配器层：端口的具体实现（sqlite、文件、git、pi 等），只在装配入口被连接。

- 允许：实现 `ports` 接口；依赖 `application`/`domain` 类型；在正式接入该能力的 Feature 引入对应第三方依赖（如 Pi SDK、better-sqlite3 + Drizzle）。
- 禁止：被 `domain`、`application`、`ports` 或公共入口直接导入；在本阶段为占位而安装或模拟 Pi、Electron、HTTP 框架；适配器写业务数据库或接管 Task 调度。

当前阶段（P01-2 / F-001）：`shiploop-core` 已在适配层固定安装 `better-sqlite3@13.0.3` 与 `drizzle-orm@0.45.3`（含 `@types/better-sqlite3@9.6.0`），驱动与 ORM 的引用只允许出现在本层及装配入口（由 `scripts/check-boundaries.ts` 与 `test/typescript-build.test.ts` 强制）。`sqlite/connection.ts` 是当前唯一代码文件：显式位置打开文件型 SQLite、幂等关闭的最小装配，供 `test/sqlite-storage-fixture.test.ts` 在系统临时目录执行真实 Drizzle 写入/读取断言；PRAGMA 策略、事务封装、迁移与业务 Schema 由 F-003 / F-004 / F-005 实现。Pi 适配器仍不在本阶段安装。
