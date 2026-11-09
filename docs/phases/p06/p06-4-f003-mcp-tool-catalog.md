# P06-4 F-003 MCP 工具目录与授权映射

`mcp-tool-catalog.ts` 是 Host/Runner 私有转换器。可信装配通过
`McpStdioConnection.createToolCatalog()` 获得目录，并将 `catalog.tools` 交给后续 Pi 装配。
本 Task 不接入 Runner 默认组合根；F-004 负责桥接执行与结果/错误语义接线。
原始 `ready.tools` 仍是私有发现快照，不能直接注册到 Pi 或工具搜索。

目录复用 F-001 启动计划里的 Pi 名称，按名称排序，只输出 server 发现结果与
`allowedTools`/计划映射的交集。每个定义只有 Pi 名称、标签、获准工具描述、参数 Schema
和绑定的执行闭包，不传播 annotations、server instructions、命令、环境或凭据。
未选 endpoint 在发现前拒绝；名称碰撞、重复工具、无效 Schema 和任何超限都失败关闭。
不返回截断的成功列表。

`resolve(piName)` 返回含 project/session/invocation、resource/source 和原始工具名的冻结绑定。
`dispatch` 只接受当前目录签发的绑定对象；克隆、伪造、未知名称或其他 Session 的绑定均拒绝。
每次执行先验证参数，再重新发现完整清单并检查原工具指纹及 server 身份。新增工具不会加入
已创建目录；撤回或身份漂移后该映射保持不可用，不能靠重新出现悄悄恢复授权。
清单复核与 server 执行之间不具备跨进程事务，不能据此承诺恶意 server 的行为或 exactly-once。

支持的 JSON Schema 子集：对象/数组/标量 type，properties/required/additionalProperties/items，
enum/const，数值上下限/multipleOf，字符串/数组/对象长度限制，uniqueItems，allOf/anyOf/oneOf，
以及 title/description/default 元数据。根参数必须是 object。仅接受 draft-07 或 2020-12 的显式
`$schema` 声明；类型数组、`$ref`、正则、format、条件及其他未实现关键字明确拒绝。
SDK 接收同一份冻结 JSON Schema；分发闭包还会独立验证参数，直接调用 execute 也无法绕过。
直接分发不做类型转换，不将 undefined/NaN 等有损 JSON 值转换后送到 server。

每个 server 的上限：128 个工具、32 页、完整发现 262144 字节、单工具描述 4096 UTF-8 字节、
单参数 Schema 32768 字节、Schema 深度 16；调用参数最多 65536 字节。分页重复游标、空页仍有
后续游标、页数或累积字节超限均产生结构化失败。连接使用私有 `client.request('tools/list')`
逐页读取，并沿用有限请求时间和进程生命周期；调用不暴露通用 MCP request/client 入口。
错误只包含稳定 reason；启动发现失败保存 `tool_discovery_failed` 及 `discoveryReason`，并沿用 F-002
关闭/停止核验。目录的调用异常暂统一为 `call_failed`，更细的取消/isError/超时语义属于 F-004。

本地验证（Node 22.19.0，无模型/外部服务）：

- 新增目录文件 30 项，结合受修改生命周期与 Fake server 回归共 3 文件、57 项全部通过，
  退出码 0，约 5 秒。真实 stdio 场景证明越权请求的实际 Fake server 调用计数保持 0；
  获准调用后撤回工具不再增加计数；两 Session 分别清理且 stopEvidence.confirmed=true。
- 使用已安装 `@earendil-works/pi-ai` 的真实 `validateToolArguments` 检查工具 Schema 与嵌套非法参数，
  同时验证直接调用的二次检查。不调用模型。
- 类型检查通过；模块边界检查通过（450 个生产源码文件、0 diagnostics）。
- 仓库索引 `test/index/phases/P06/features/P06-4/tasks/F-003.json` 登记七文件；其中 F-001、
  既有 Pi 提交工具、Work 资源选择与 Runtime 访问四文件仅选择，交 Nezha 独立复验。

完整日志及真实退出码 sidecar 位于 Feature workspace 的
`verifications/F-003/runtime-logs/`：RED `test-8zvoa0g5.log`，最小 GREEN `test-im8e7qg9.log`，
最终定向测试 `test-k8hed0i_.log`，最终类型检查 `test-y8305e4t.log`，边界检查 `test-qbxqgirx.log`。
中间验证及类型失败日志原样保留。未运行全仓/Phase 门禁或真实模型；Task 接受与 Feature 验收由 Nezha 决定。
