# P06-4 F-008：Pi Work stdio MCP 接线

本任务把前序启动计划、stdio client、过滤 catalog、审计和持久进程登记接入标准 Pi SDK Work Session。只支持获准的本地 stdio；不加载 SDK 内置 MCP 扩展，不读取 `~/.pi/agent/mcp.json` 或项目 `.pi/mcp.json`。

## 可信装配

`PiTrustedAssembly.mcp` 接受 `PiMcpAssembly`：

- `resolver`：复用 F-001 的 `McpTrustedResourceResolver`，每个 Attempt 按当前批准快照解析来源、版本/内容摘要、工具授权和最小环境；不得发现默认目录或取 owner 凭据。
- `processRegistry`：复用 F-006 的持久登记。`registerProcess` 的确认仍须来自可信 Host/控制层；持久登记和确认均完成后才进行 initialize。
- `recordManifest(request, manifest)`：保存本次实际握手/过滤后的加载结果，以传入 request 的 project/session/Attempt/invocation/executionVersion 关联。它是证据写入端口，不能修改批准输入或业务验收状态。写入失败拒绝启动并清理已创建的 server。
- 握手、调用、清理预算仍由 F-005/F-006 限制，并受本次启动的外层绝对 deadline 约束。

`prepareAccess` 先执行认证和冻结资源快照核对。Adapter 校验 manifest 摘要、项目、selectionRevision、每项来源和实际能力以及禁用隐式扫描的策略。之后只解析选中的 MCP 条目；无 MCP 选择时不解析来源、不创建连接。

`resolveSubmissionTools` 与过滤后的 MCP 工具共同校验去重。`resolveBuiltInTools` 是可信权限映射的显式入口，缺省保持内置工具禁用；所有 SDK 内置名称保留，不能被自定义工具覆盖。`modelRuntime`/`settingsManager` 可由可信装配显式提供，便于认证和离线验证，不接受请求或模型覆盖。

SDK 工厂始终传入精确工具清单，创建后再次应用并核对该清单。未选择的工具不会因原生历史中的工具声明而被激活。工具参数仍经过 SDK 和 MCP catalog 校验，受限提交工具的执行函数和 Host 通道保持原有权限语义。

## 生命周期与记录

每次启动先建立独立 MCP scope，连接只归属本次调用。成功握手、完整匹配获准工具并保存实际 manifest 后，才创建 SDK Session 和发送 prompt。

- 必需 server、发现工具或来源不可用时，prompt 前拒绝；显式可选条目按 `omit` 省略，实际 manifest 和诊断保留 `unsupported`/`unverified` 缺口。
- `prepareAccess` 失败发生在 spawn 前。输入读取、工作目录解析、恢复来源核验、SDK 创建/初始化或 manifest 保存失败，都会关闭此前获取的 MCP 连接。
- 正常完成、工具错误、取消、超时和 Runner SIGTERM/SIGINT 均走同一幂等清理路径。Runner 在 `adapter.start` 之前建立停止信号和 deadline，输出通道失败也等待有界停止观察。
- 持久停止登记失败时保留登记，并把 Runtime 结果标为 `mcp_cleanup_unconfirmed`；不释放恢复写入者资格。
- MCP 审计拥有已派发调用的唯一开始/终结，SDK 的对应外层通知不重复发送。SDK 在桥接调用前拒绝非法参数时，仍记录一组失败工具事件及 `pi.mcp.sdk_rejected` 诊断。
- MCP 进程组停止、SDK idle 和 Runner/其他资源停止是不同证据。Adapter 继续返回 `stopped.confirmed=false`，由既有 Host/Core 独立资源核验决定占用释放。SIGKILL 无法运行 finally 时，继续使用 F-006 持久登记与恢复核验，不以本任务的 SIGTERM 实测代替崩溃恢复证明。

恢复创建新的 Attempt、invocation、原生档案和 MCP client，重新解析授权来源；不复用原 server，不恢复 MCP 调用队列。Pi 1.0.4 真实工具轮次会保存 `system` 提示/工具声明补丁，恢复校验器现仅接受其已知字段；异常字段、无效 sections/schema 或可执行声明继续拒绝。历史声明只用于对话，当前执行权限由新工具清单决定。生产恢复能力默认值没有提升，离线实测使用独立的测试环境能力证据。

## 验证范围

新增三个模块文件覆盖真实固定版本 SDK、脚本化本地响应（零模型/网络请求）、本地 Fake MCP server、原生 JSONL 续接和真实受监督 Runner SIGTERM。测试目录、可信索引及 Harness selection 见：

- `test/modules/runtime/p06-4-f008-pi-mcp-session.test.ts`
- `test/modules/runtime/p06-4-f008-pi-mcp-lifecycle.test.ts`
- `test/modules/runtime/p06-4-f008-pi-mcp-recovery.test.ts`
- `test/index/phases/P06/features/P06-4/tasks/F-008.json`

测试包括未选 server/工具不可见、内置 read/受限提交/MCP 共存、MCP `isError`、SDK 参数拒绝不产生副作用、唯一工具事件、启动失败矩阵、可选来源不可用、清理不确定、输入冻结，以及三次真实 SDK Attempt 中独立调用和取消 MCP 选择后的历史恢复。

已有提交工具与 Runner 取消回执按 `sdk-tool-wiring`、`runner-control-abort-receipt` 两个 case 本地验证。其余索引中的旧模块回归交由 Nezha 独立执行，不把选择清单当成通过结果。完整日志和 `.log.exitcode`/`.log.json` 位于 Harness `verifications/F-008/runtime-logs/`：

| 本地范围 | 结果 | 最终日志 |
| --- | --- | --- |
| 新增三个模块文件 | 31 passed，0 failed，0 skipped，4.769 秒 | `test-slv0zh07.log` |
| 既有提交/取消两个精确 case | 2 passed，其余 33 项因 `-t` 未运行 | `test-uh8txihr.log` |
| 类型检查 | exit 0 | `test-9kp5qicp.log` |
| 模块边界 | 453 个生产文件，0 diagnostics，exit 0 | `test-qw7zliwq.log` |

原始 RED、夹具修正和中间失败日志全部保留。其余索引回归未在本地执行，由 Nezha 独立复验。

未运行全仓测试、组合 verify、Phase 验收、真实模型或远程 MCP；没有改写 Core 状态、受限通道或 owner 权限。桥接成功、Runtime completed 和本地测试通过都不代表 Task/Feature/Phase 已验收。
