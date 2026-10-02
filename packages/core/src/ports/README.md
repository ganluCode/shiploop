# Core · ports

端口层：StateStore、RuntimeAdapter、ArtifactStore、Git、凭据、通知等窄接口与契约类型（错误码、事件游标、取消语义等）。

- 允许：仅声明接口、类型、结构化错误与契约常量；引用 `domain` 类型。
- 禁止：任何具体实现与可执行副作用；导入或重导出 Pi SDK、Electron、HTTP Request/Response 对象、HTTP 框架、`better-sqlite3`、Drizzle；为占位而声明当前没有使用者的端口。

当前阶段（P01-2）：已建立最小契约面——`errors.ts`（结构化错误）、`validation.ts`（运行时校验原语）、`settings-schema.ts`（schemaVersion=1 的限定配置 Payload Schema）、`state-store.ts`（项目与全局/项目当前配置窄契约）、`artifact-store.ts`（制品索引与有效输入引用契约）、`artifact-files.ts`（F-010 制品文件窄契约：受控逻辑定位、staging 生命周期、不覆盖发布与有界扫描的表达形态）、`migrations.ts`（迁移记录契约）。全部为类型、常量与纯校验函数，无任何 I/O；真实 SQLite 适配器自 F-003 起、真实文件系统适配器自 F-010 起实现这些端口，语义基线由 test/storage-contracts.test.ts 与各适配器回归测试固定。
