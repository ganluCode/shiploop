# Core · domain

领域层：状态规则、策略与值类型（Project / Phase / Feature / Task、Batch / Run / Attempt 的生命周期规则）。

- 允许：纯 TypeScript 值类型、常量、纯函数、领域错误；依赖 Node 内置的无副作用工具（如 `node:util` 的类型）。
- 禁止：导入 `application`、`ports`、`adapters`；导入或重导出 Pi SDK、Electron、HTTP 框架、`better-sqlite3`、Drizzle；读取文件系统、网络、时钟以外的环境状态；静态注册占位服务。

当前阶段（P01-1 / F-002）无代码文件；目录由本说明确立边界，业务实现从后续 Feature 开始按设计 `core-design/02-domain-and-lifecycle.md` 进入。
