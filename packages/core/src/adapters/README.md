# Core · adapters

适配器层：端口的具体实现（sqlite、文件、git、pi 等），只在装配入口被连接。

- 允许：实现 `ports` 接口；依赖 `application`/`domain` 类型；在正式接入该能力的 Feature 引入对应第三方依赖（如 Pi SDK、better-sqlite3 + Drizzle）。
- 禁止：被 `domain`、`application`、`ports` 或公共入口直接导入；在本阶段为占位而安装或模拟 Pi、SQLite、Electron、HTTP 框架；适配器写业务数据库或接管 Task 调度。

当前阶段（P01-1 / F-002）无代码文件、无第三方依赖；Pi 适配器与 SQLite 适配器分别在后续 Feature 按 `core-design/05`、`core-design/03` 的设计与已记录实验基线接入。
