# Core · application

应用层：命令、查询与执行编排（用例服务、调度、预算、验收编排）。

- 允许：依赖 `domain` 与 `ports` 中声明的窄接口；以显式调用组织用例；依赖注入在边界装配。
- 禁止：依赖具体适配器实现（`adapters/*`）；导入或重导出 Pi SDK、Electron、HTTP 框架、`better-sqlite3`、Drizzle；直接发起网络监听或持有用户数据路径之外的写入；空壳的项目/调度/存储/Runtime 服务。

当前阶段（P01-1 / F-002）无代码文件；目录由本说明确立边界，用例实现从后续 Feature 开始按设计 `core-design/04-scheduling-and-recovery.md` 等进入。
