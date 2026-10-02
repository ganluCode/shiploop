# Core · ports

端口层：StateStore、RuntimeAdapter、ArtifactStore、Git、凭据、通知等窄接口与契约类型（错误码、事件游标、取消语义等）。

- 允许：仅声明接口、类型、结构化错误与契约常量；引用 `domain` 类型。
- 禁止：任何具体实现与可执行副作用；导入或重导出 Pi SDK、Electron、HTTP Request/Response 对象、HTTP 框架、`better-sqlite3`、Drizzle；为占位而声明当前没有使用者的端口。

当前阶段（P01-2）：已建立最小契约面——`errors.ts`（结构化错误）、`validation.ts`（运行时校验原语）、`settings-schema.ts`（schemaVersion=1 的限定配置 Payload Schema）、`state-store.ts`（项目与全局/项目当前配置窄契约）、`artifact-store.ts`（制品索引、有效输入引用与 F-012 起的有界分页 listArtifacts 契约）、`artifact-files.ts`（F-010 制品文件窄契约：受控逻辑定位、staging 生命周期、不覆盖发布与有界扫描的表达形态）、`migrations.ts`（迁移记录契约）。全部为类型、常量与纯校验函数，无任何 I/O；真实 SQLite 适配器自 F-003 起、真实文件系统适配器自 F-010 起实现这些端口，语义基线由 test/storage-contracts.test.ts 与各适配器回归测试固定。

P01-3 / F-003 起新增 `path-service.ts`（统一 PathService 窄契约：稳定 dataNamespace 与 macOS 默认根纯推导、`core.sqlite` 与 `projects/<id>` 受控位置、资源类型白名单、受权定位入口与 `PathResolutionError`），同样为纯契约无 I/O。

P01-3 / F-004 起新增 `repository-inspector.ts`（只读仓库路径检查窄契约：`RepositoryInspection`/`RepositoryInspector`、`RepositoryInspectionError` 八类 kind、有限超时与输出上限常量、`validateRepositoryInspectionPath` 纯校验与 `deriveRepoIdentity` 纯哈希派生），同样为纯契约无 I/O；真实 Git 实现在 adapters 层。

P01-3 / F-005 起 `state-store.ts` 扩展仓库绑定窄契约：`RepositoryBindingRecord`、`validateCreateRepositoryBindingInput`（realpath 规范路径/非空身份在任何 SQL 之前校验）、`createProjectWithRepositoryBinding`（项目+绑定原子组合创建，`canonical_path` 唯一幂等复用返回 `registered`/`already_exists`）与 `getRepositoryBinding`；`errors.ts` 的 `StorageEntityType` 相应新增 `repository_binding`。纯契约无 I/O；真实 SQLite 实现在 adapters 层。

P01-3 / F-006 起 `state-store.ts` 补充项目元数据审计契约常量：`PROJECT_METADATA_UPDATED_EVENT_TYPE`、`StateEventAggregateType` 与纯函数 `projectMetadataChangedFields`（从已校验更新输入派生脱敏字段名）。`updateProject` 契约注明：成功更新在同一短事务内追加一条 `state_events` 脱敏审计记录，失败一并回滚。仍为纯契约无 I/O。

P01-3 / F-007 起 `state-store.ts` 扩展项目查询窄契约：`ProjectLabelMatchMode`/`ProjectListFilter`/`ProjectPage`/`ProjectLabelCount`、有限分页常量 `PROJECT_LIST_DEFAULT_LIMIT`/`PROJECT_LIST_MAX_LIMIT` 与纯校验 `validateProjectListFilter`（标签复用 `normalizeLabels`，非法 match/limit/cursor/未知键在 SQL 之前拒绝），以及 `StateStore.listProjects`（任一/全部标签筛选、稳定 `id` 升序键集分页、绑定参数防注入）与 `StateStore.countProjectLabels`（项目层去重计数、不跨层级求和）。仍为纯契约无 I/O；真实 SQLite 实现在 adapters 层。

P01-3 / F-008 起 `settings-schema.ts` 显式升级为 schemaVersion=2：新增本阶段确认的政策子集 `policies`（`executionLimits` 有界数值与非敏感环境变量名允许列表、`verification.requireChecksBeforeDone`、`securityPolicy.isolation` 仅 `trusted_project`，未知政策段/强隔离请求明确拒绝不降级）、凭据引用卫生（`credentialRef`/`endpointRef` 拒绝带凭据 URL/空白/控制字符/超长，明文秘密字段作为未知键拒绝且错误不回显秘密值）、`SettingsScope`/`validateSettingsScope` 与 `listStrategyEntries` 策略条目枚举；v1 payload 与 v1 持久数据一律拒绝（读取为 corrupt），不静默误读旧版本。新增 `runtime-capabilities.ts`：可信装配注入的窄能力描述（`RuntimeCapabilityDescriptor`/`ProviderCapabilityDescriptor`/`RuntimeCapabilityCatalog`）、`createStaticRuntimeCapabilityCatalog`（重复 runtime/provider ID 明确报错）、`validateStrategyCapabilities`（未知 runtime/不兼容 provider/未列举 model 带字段定位拒绝，无封闭厂商枚举、不查网络、不导入 Pi SDK）与 `assessSettingsConfiguration`（区分配置合法性与执行能力可用性：P01 未装配执行能力，executable 恒 false）。全部为纯契约/纯函数，无 I/O。

P01-3 / F-010 起 `state-store.ts` 补充当前配置写入审计与一致性前置条件契约：`GLOBAL_SETTINGS_UPDATED_EVENT_TYPE`/`PROJECT_SETTINGS_UPDATED_EVENT_TYPE` 事件类型常量、纯函数 `settingsChangeSummary`（从已校验 payload 派生只含策略键名/政策段名/schemaVersion 的脱敏摘要，不含值/引用/秘密）、`SettingsWriteConsistency` 与项目配置写入专用校验器 `validateCreateProjectSettingsInput`/`validateUpdateProjectSettingsInput`（接受可选 `consistency.globalRevision` 前置条件，由适配器在同一写事务内核对，不一致返回 conflict `stale_dependency`）。`updateGlobalSettings`/`updateProjectSettings` 契约注明：成功更新在同一短事务内追加 `state_events` 脱敏审计记录，失败一并回滚。仍为纯契约无 I/O。
