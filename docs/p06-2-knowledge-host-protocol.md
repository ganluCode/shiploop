# P06-2 / F-007 知识查询 Host 契约

复用本机 Host 的认证、项目读取授权、GET 查询规则和有限请求预算。Core 已装配的 `knowledgeQueryService`、`memoryQueryService` 由 `startHost` 接入；Host 不直接查询数据库或按请求路径读取文件。

| 操作 | GET 路由 | HostClient |
| --- | --- | --- |
| `knowledge.search` | `/v1/projects/:projectId/knowledge/search` | `searchKnowledge(projectId, input)` |
| `knowledge.read` | `/v1/projects/:projectId/knowledge/read` | `readKnowledge(projectId, input)` |
| `memory.search` | `/v1/projects/:projectId/memory/search` | `searchMemories(projectId, input)` |

`projectId` 由项目路由确定，再由 Core 对认证主体执行 `project.read` 和项目可见性检查。请求体、重复查询参数、查询内 `projectId`、principal/actor 字段均拒绝。受限 Work 凭据仍只通过既有工具通道使用；新增查询不会赋予其 owner HTTP 权限。

文档搜索支持 `documentId/version/keyword/title/path`，记忆搜索支持 `keyword/recordKey/scope/version`。两者使用已有 Core 的 `limit/snippetMaxChars/maxReadBytes/maxCandidates` 上限和默认值；读文档接收 `documentId/version/maxReadBytes`。`path` 是受控逻辑路径片段，不能提供任意物理文件路径。所有参数复用 Core 校验，数字查询参数必须是正十进制整数。

握手按方法分别发现三个能力，仅在实际装配对应函数时宣告。能力名称由独立的 Host 契约声明，测试核对其与 Core 查询操作集合一致；Host `contract/` 不依赖 Core 包，响应校验器由传输及客户端层复用。缺席方法返回 `501 unsupported`。未装配旧上下文的能力清单保持原有形状；握手仍严格拒绝未知能力与重复项。沿用现有 Host schema v5 / protocol v1，知识响应使用独立 schemaVersion 1；客户端和 Host 随同一仓库版本发布。

`shiploop-core/protocol` 导出纯数据类型、输入校验和 `validateKnowledgeQueryResponse`，Host 输出与 HostClient 解码使用同一响应校验器。文档/记忆结果保留来源制品引用、版本、hash、片段、位置、选择理由、预算和诊断。所有嵌套引用必须属于响应项目；额外存储字段、物理 locator、非法预算、未知版本均拒绝。现有 SQLite 检索投影的 `sourceLocators` 可以为空，来源追踪以 `sourceRefs` 的项目/制品/version/hash 为依据。

HostClient 另外比对响应项目、查询条件、请求预算与指定文档/记忆版本，文档正文复算 SHA-256。正文只由已有 ArtifactVerifier 核验读取。搜索 JSON 响应上限 1 MiB，正文 JSON 上限 32 MiB，超限失败关闭；正文读取仍受 Core 原有字节预算限制。客户端沿用 `appRequestMs` 有限超时，超时和连接故障不会变成空结果。

| 情况 | 可观察结果 |
| --- | --- |
| 无匹配 | 空 results 和 `no_results` diagnostic |
| 搜索读取预算不足 | `budget_exceeded` diagnostic，不截断正文冒充命中 |
| 读文档预算不足 | `invalid_input`，reason=`budget_exceeded` |
| 缺失/不可用文档版本 | `not_found` |
| 跨项目主体或引用 | `forbidden`，不返回正文 |
| 搜索正文损坏 | `corrupt_content` diagnostic |
| 读文档正文损坏 | `corrupt_state` |
| 缺席能力 | `unsupported` |
| 未知响应版本/畸形响应 | `unsupported_schema_version` / `response_malformed` |
| 未预期内部异常 | 固定 `internal`，不透传异常消息、堆栈、凭据或物理路径 |

新增局部测试使用真实临时 Git/SQLite、生产 `startHost`、发现握手与 loopback HostClient，比较查询前后的全部持久表并核对重启前后文档和记忆响应。受限主体测试通过可信测试装配验证授权，伪 Host 只用于客户端畸形响应、hash 与超时负例；不调用模型。

Task 索引为 `test/index/phases/P06/features/P06-2/tasks/F-007.json`。新增局部文件在 Runtime 验证，已有 Host、Core 查询、基线、Profile 与协议依赖回归交 Nezha 独立复验；局部通过不代表 Feature/Phase 验收通过。
