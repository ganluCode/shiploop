# P06-4 F-002：stdio MCP 连接生命周期

本 Task 交付 Host/Runner 边界的连接组件和本地无凭据 Fake server，不代表整个 Feature、Pi 工具入口或 Phase 已验收。固定使用 Node 22.19.0、现有 `@earendil-works/pi-mcp@1.0.4`，没有新增依赖。

## 可信装配接口

- `createMcpStdioConnection({ plan, server?, registerProcess, ...budgets })`：使用 F-001 已批准的计划；多个 server 时显式选择计划中的一项。构造时复制并冻结计划，后续调用方修改不会改变实际启动输入。
- `createMcpStdioConnectionManager()`：按 project/Session/server/invocation 认领一次启动。同一身份的并发、重复调用复用同一个 Promise；完整计划数据或摘要变化拒绝；失败和关闭后都不隐式重连。
- `startMcpStdioConnections(...)`：串行构造一个计划中的连接；后续连接失败时回滚先前已取得连接，并保留未确认清理错误。单个连接的 `processRegistration` 和 `stopEvidence` 提供关联证据；持久化仍由可信登记方负责。

流程是 `not_started → starting → available`；初始化、能力检查及 `tools/list` 全部成功才可用。失败为 `failed`，正常显式关闭为 `closed`；无法证明进程组消失时保留 `failed/cleanup_unconfirmed`、原始失败类别及登记身份。`close()` 和 `start()` 各自幂等。

组件先以独立进程组和三条私有管道启动 executable，取得真实 macOS pid/pgid/startTime 与独立 launchId，再调用 `registerProcess` 提交 project/Session/server/invocation/计划摘要归属。登记回执必须匹配 launchId，之后才发送 `initialize`。这保证协议请求不会先于登记，不将 server 自身启动当成 OS 沙箱。可信项目下仍可能执行启动代码；不宣称阻止同用户恶意进程。

环境只包含固定系统 PATH 和获准环境值，使用独立 argv、`shell:false`。MCP stdout 仅由私有 newline JSON-RPC transport 消费，不进入 Runner 消息通道；stderr 为私有有界尾部，不进入公开错误或就绪快照。错误只含稳定类别，避免携带服务器异常正文、命令、路径和环境值。

`McpClient` 负责协议初始化、请求关联及分页发现；本组件负责登记、绝对启动预算、消息/总输出上限、管道和进程生命周期。关闭会释放 SDK 请求计时器/监听器和私有管道，并通过有限 OS 检查核实进程组消失；未知枚举或身份核验失败不当成停止。生命周期关闭不直接释放任何 Core 占用。

## Fake server 与局部证据

`test/helpers/mcp-stdio-fake-server.mjs` 是独立本地程序：文件屏障标记 ready、initialize、initialized、tools/list、进入调用及退出，支持挂起初始化/发现/调用、JSON-RPC 错误、isError、异常退出、协议噪声、超大输出、stderr 压力及同组受控子进程。调用屏障保留实际请求 ID、参数和计数。测试使用临时目录和真实 OS 进程清点，不访问凭据或模型。

本地最终结果：

- 两个 F-002 文件共 **27 项通过**：`test-2am_ervf.log`。
- 类型检查通过：`test-coowh3ke.log`。
- 模块边界通过：449 个生产源文件、0 diagnostics：`test-zmeqcoqu.log`。
- 原始 RED：`test-rng4smtc.log`；中间失败日志保留。一次诊断日志误写到重复目录，其 `test-heer6b7s.log`、退出码和 JSON 已复制回本 Task 的证据目录，不改写原记录。

上述日志均位于 Feature workspace 的 `verifications/F-002/runtime-logs/`，每次由 Nezha test-command helper 保留 stdout/stderr、真实退出码和 sidecar。最终真实进程检查未发现 Fake server 遗留。

索引：`test/index/phases/P06/features/P06-4/tasks/F-002.json`；Harness `verifications/F-002/test-selection.json` 仅引用此索引。两个新文件已本地运行；F-001 启动计划、既有 Runner、受监督命令和停止回归四文件仅登记，交 Nezha 独立复验，不能视为本地通过。

## 后续任务边界

这里返回的是可信桥接内部的原始发现结果，未注册为 Pi 工具。F-003 负责 Schema/获准工具交集，F-004 负责调用分发/结果语义，F-005 负责调用取消、外层预算与更完整的后代故障矩阵，F-006 负责 Host 资源/恢复接线，F-007/F-008 负责审计及生产 Pi 装配。当前未运行全仓/Phase 验收、真实模型或外部 MCP 服务，也未修改正式 Task/Feature 状态。
