# Core · ports

端口层：StateStore、RuntimeAdapter、ArtifactStore、Git、凭据、通知等窄接口与契约类型（错误码、事件游标、取消语义等）。

- 允许：仅声明接口、类型、结构化错误与契约常量；引用 `domain` 类型。
- 禁止：任何具体实现与可执行副作用；导入或重导出 Pi SDK、Electron、HTTP Request/Response 对象、HTTP 框架、`better-sqlite3`、Drizzle；为占位而声明当前没有使用者的端口。

当前阶段（P01-1 / F-002）无代码文件；目录由本说明确立边界，端口随首个实际用例的 Feature 引入，不预先批量建空壳。
