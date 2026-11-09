# P04-2 F-001 Work 访问契约

入口：`packages/core/src/ports/work-access.ts`，由 Core 公共入口导出。
本任务仅定义声明、校验与脱敏 manifest；认证解析、资源实际加载及受限业务通道由后续 Task 实现。

- `validateWorkAccessConfiguration(value, binding)` 校验未知输入并返回独立的规范化数据。
- `buildWorkAccessManifest(value, binding, gaps?)` 重校验声明，将可信能力核验给出的缺口与批准声明一起生成 SHA-256 摘要。
- `WorkAccessError` 只携带固定消息与 `reason` 分类；`details` 只有同一个受控原因，无原始值、动态字段名或 cause。

`binding` 必须来自当前可信认证上下文、Attempt 和已批准策略，不能取自待校验声明。核对 principal、项目可见性、Host 实例、Run/Task/Attempt、invocation、executionVersion 及 runtime/provider/model。上下文还必须提供独立 grantId、签发时间、到期时间及非空操作集合。到期时刻不可用；有效期最多一天；当前时间由控制层显式提供，不在契约内读取时钟。原生 sessionId 不能替代授权字段。此校验不签发权限、不证明 Attempt 当前可执行；撤销、终态、恢复后的当前状态和具体操作权限必须在使用时由 Core 再核验。

认证仅接受 `environment`、`local_login`、`plugin` 三种来源。sourceRef、environmentRefs、资源 id/sourceRef 及认证 pluginId 使用小写 UUID v4 不透明引用，由可信装配解析注册映射；没有路径、环境值、插件参数或 SDK 私有透传字段。这里的 environmentRefs 是获准环境映射的引用，不是环境变量正文，不要求复制已有用户登录。该引用格式不修改既有 settings 的 credentialRef 或任何存储 schema。

资源类型为 auth_plugin、skill、mcp、extension、tool。身份在所有类型之间唯一，每项提供来源及版本或内容摘要（缺省项显式 null）；认证插件还必须锁定版本、标记必需且拒绝降级，并被 authentication.pluginId 明确选中。普通扩展不能替代认证插件。MCP 传输仅可声明 stdio 或 streamable_http；声明不代表当前 SDK 已支持。资源最多 64 项，每项环境引用最多 32 项，模型及身份 token 最多 128 字符，所有集合有界并拒绝重复。提供任意路径、正文或未知键直接拒绝，不尝试剥离秘密后继续。

允许操作仅有 task.read、candidate.submit、evidence.submit，分别描述当前任务只读查询、候选提交及证据提交，不是新增的 Host 命令。后续通道必须映射到既有授权链，不提供审批、标通过、预算、锁或批次控制。

能力词汇为 resource_selection、tool_interception、mcp_stdio、mcp_streamable_http、auth_plugin。可信装配报告的 unsupported/unverified 缺口必须指向已选资源上声明的能力；只有 required=false 且 onUnavailable=omit 可以记录降级，必需资源或 reject 策略立即拒绝。空缺口集合只表示没有报告缺口，不表示已经认证 ready、资源加载成功或实际推理可用。

manifest 保留上述经过校验的批准声明与脱敏缺口。摘要采用 `shiploop:work-access:v1` 加换行及 stableStringify(body)，body 包含 schemaVersion/access/gaps。对象键、资源、操作、环境引用、能力和缺口排序规范化；模型、资源指纹、权限或执行身份变化会改变摘要。manifest 的 digest 不参与自身计算。

模块只依赖 node:crypto 及现有纯契约模块（authorization、feature-plan），settings 仅类型引用；不导入 SDK、HTTP、SQLite 或文件系统，也不生成随机身份、不读取环境或业务状态。测试复用公共入口加载守卫，在禁止厂商 SDK、HTTP 和 ORM 的干净 Node 进程中核对新导出。

本地验证与未运行回归分开记录在 Harness progress.md。测试索引：`test/index/phases/P04/features/P04-2/tasks/F-001.json`。现有消费者无需 fixture migration；只有新访问契约调用者需要显式提供 binding 和引用映射。
