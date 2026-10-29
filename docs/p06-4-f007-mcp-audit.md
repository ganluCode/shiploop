# P06-4 F-007 MCP 审计交接

本任务提供 MCP 调用/生命周期审计生产者，并接到 `mcp-tool-catalog.ts` 和 `mcp-stdio.ts`。
真实 Pi Work 组合根的装配属于 F-008；本交接不声明 Feature 或 Phase 已通过。

- `createMcpRuntimeAudit({ plan, publish, requestStop })` 按完整私有启动计划绑定 project、Session、Attempt、invocation 和 executionVersion。一个 invocation 的所有 server 共用同一实例，跨计划/执行代次拒绝。私有计划包含环境解析结果，不得写入输入快照、报告或 Runner argv。
- `publish` 是现有 Runtime 事件流的同步、有界准入回调，只接收 `RuntimeEventPayload`。适配器应使用既有 invocation 事件前缀和共享单调序列封装，交给既有 `PiRunnerEventChannel`/wire/Work Recorder，不另外创建 MCP 日志事实源。返回 `false` 或抛错时，生产者请求停止并永久阻止后续调用；准入不是落盘确认。
- 调用复用 `tool_started.input` / `tool_finished.output` 的 JSON 正文，内部封套 `schemaVersion: 1`，保留 server、执行身份、阶段、原因和覆盖度。工具退出码/信号未知时保持 null。生命周期使用 `message.text` 的结构化正文，`toolCallId: null`，不冒充工具调用。现有公共 Runtime 事件 schema 和 wire 版本不变。
- 相同工具调用 ID 与请求摘要复用唯一 Promise，包括失败/不确定结果；冲突摘要、越权复制绑定和记录数量上限均阻止后续，不能通过重复调用重新执行副作用。无原生调用 ID 的观察以 partial 生命周期形状记录并在副作用前拒绝，不伪造工具身份。Pi 与 MCP 共用 `pi-event-identity.ts` 的公开 ID 归一化规则。
- F-008 装配时应由审计生产者负责 MCP 工具事件，避免再把同一次 SDK `tool_execution_start/end` 作为第二套终结通知发布；其他内置/提交工具保持原管道。取消必须接到该 invocation 的 Runtime 和所有 MCP 连接；清理后才关闭事件流，等待 Recorder 独立完成。`audit.failed` 及 required Recorder 失败均不能被正常 SDK 退出覆盖。

正文按既有 `createOutputRedactor` / `redactOutputText` 策略处理。显式私有环境值视为需要脱敏的字面量，参数/结果的键与值都处理；工具描述、Schema、握手结果和交给 Pi 的返回值在原生持久化前处理。stderr 使用 UTF-8 解码和跨 chunk 流式脱敏后才进入有限尾缓冲。argv 含已解析的私有环境值时在 spawn 前拒绝。第三方调用错误只通过既有稳定分类返回，原始 message/cause 不进入审计或 Pi 工具错误。

单条结构化正文最多 4096 字节，调用去重表最多 2048 项。超限内容明确省略并保留 `partial`、gap 和已观察字节数；stderr 截断保留真实计数。清理正文优先保留进程身份、确认结论及其规范 JSON 的 SHA-256，即使 stderr 超限也不丢弃已有停止证据。特殊诊断 `mcp.audit_gap` 由既有 Recorder 计入 `mcp_audit_gap`，required 模式不能生成 complete。实际正文制品引用、content hash 和持久水位由 Work Recording 投影发布、校验和索引；没有引用已删除的临时目录或 logger。应向 Recorder 同时提供相同的可信字面量脱敏集合，以保留 manifest 的脱敏范围声明。

审计完整度、MCP 子进程停止、Runtime 停止和 Task 验收是独立事实。测试中特意保留 Runtime stop=false，同时 MCP cleanup=true；也覆盖 cleanup=false 但观察记录完整。任何一种都不能据此设置 Task passed 或释放未经 Core 核验的占用。

本地验证使用无凭据本地 Fake server、真实临时 SQLite/Artifact、实际固定 Pi SDK 和脚本化离线模型 transport。新增测试：

- `p06-4-f007-mcp-audit.test.ts`：身份、拒绝/isError/错误分类、去重与复制绑定、限额/停止、记录准入失败。
- `p06-4-f007-mcp-audit-recording.test.ts`：真实进程超时/取消/退出/启动协议故障，wire 往返，SQLite 持久水位，临时源删除后的制品与清理摘要，stderr 缺口和 required 写入失败。
- `p06-4-f007-mcp-native-redaction.test.ts`：实际 SDK 工具循环和原生 JSONL；合成秘密不进入工具声明/返回结果/第三方错误档案，网络和模型服务均未调用。

本地最终定向复验：三个新增文件 **28 passed、0 failed、0 skipped**，约 12.1 秒，日志
`verifications/F-007/runtime-logs/test-m76j7qty.log`（完整输出及 helper 退出码/JSON 旁文件）。
其他 13 个既有回归文件仅登记，交 Nezha 独立验证，未宣称本地通过。
类型检查通过：`verifications/F-007/runtime-logs/test-rjnckota.log`；边界检查通过：
`test-sy2z0z2f.log`（452 个生产源码文件，0 diagnostics）。
运行日志位于 Harness `verifications/F-007/runtime-logs/`，范围以仓库
`test/index/phases/P06/features/P06-4/tasks/F-007.json` 为准。
本地结果和仅选择交 Nezha 的回归须分别记录；独立 Task/Feature 验收由 Nezha 执行。
未运行全仓、组合 verify、Phase 验收、真实模型或远程 MCP。
