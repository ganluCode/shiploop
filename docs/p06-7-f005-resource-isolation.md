# P06-7 F-005：stdio MCP 与资源隔离场景

F-005 增加首次执行/对话恢复、受限接口、真实进程故障组合场景，并补齐 MCP 登记表在重建后使用的默认停止实现。仅本地离线验证，不表示 Feature 或 Phase 验收通过。

## 实现与证据映射

| 验收行为 | 入口及实际断言 |
| --- | --- |
| 有限 initialize、tools/list、获准调用 | `runtime/p06-7-f005-resource-isolation.test.ts` 使用真实固定版本 SDK、Fake stdio server 和脚本化模型事件。关联 project/session/invocation/server、进程登记、工具白名单、原生 toolResult 和实际调用计数。 |
| 首次执行与恢复资源不扩大 | 同文件在两个 Attempt 间增加当前配置 revision 和未选 Skill；旧输入快照保持不变。恢复使用核验的原生历史、只读来源和单写入者 lease；新 Session 只暴露获准 MCP 与 Skill。原生历史中的未选工具调用不获得执行能力。全局/项目 Skill、MCP 配置和默认扩展均不加载。 |
| 启动及分发前拒绝 | 同文件拒绝三类隐式扫描、未知请求 schema、伪造主体及项目/invocation 漂移；真实跨项目句柄拒绝后两侧零调用，合法调用仅到当前 server。非 stdio、工具碰撞、导入资源和真实 Skill 文档边界使用 Task 索引中的既有专项回归。 |
| 接口授权 | `host/p06-7-f005-resource-authorization.test.ts` 使用真实 loopback HTTP、组合 Core、临时 SQLite/Git，覆盖合法只读、跨项目、伪造主体、越权审批/通过/SQL、过期、撤销、新注册表拒绝旧凭据、可信重新签发。逐次核对业务状态不变、owner dispatch 为零、错误中无凭据。 |
| 错误与迟到响应 | `runtime/p06-7-f005-mcp-faults.test.ts` 核对握手超时、协议不兼容、畸形工具 schema、异常退出、调用超时、大输出和取消后的真实迟到响应。server 文件证明调用已经发出且计数为一；失败不重放，不承诺 exactly-once。 |
| 强杀、重建与隔离 | `runtime/p06-7-f005-process-recovery.test.ts` 启动真实 Runner/server/后代，强杀 Runner，核对 detached MCP 仍存活；重开 SQLite 和持久登记表。停止无法确认时三项工作区租约保持 quarantined，伪造停止凭据及替代 Task 认领均拒绝。实际停止并清空登记后也保留业务隔离。 |
| 身份与停止负例 | 同文件用真实进程验证启动时间不匹配、进程清点失败不发信号且保留登记；忽略 SIGTERM 时有限升级并核验整个进程组消失。 |

以上测试路径均相对于 `test/modules/`。复用夹具位于 `test/helpers/p06-7/resource-scenario.ts`、`resource-runner-child.ts`；Fake server 新增取消后回包和 stdin 断开后保活模式。既有 `mcpWorkFixture` 新增可选 projectId，原默认行为不变。

## MCP 重建停止实现

`packages/host/src/runtime/mcp-stdio.ts` 提供 `recoverMcpStdioProcess`；`registry.recover(scope)` 默认调用它，仍允许可信装配传入已有停止器。普通命令停止器要求其 supervisor 的命令身份，不能作为直接启动 MCP 进程的默认实现。

重建路径使用保存的 launch/PID/PGID/启动时间，每次信号前核对真实进程身份，分别设置宽限及总截止时间；只有完整清点证明进程组消失才删除登记。清点异常、身份变化或无法重新核对已退出的 leader 时返回 unconfirmed，保留登记。该保守结果需要外部核对，不能仅凭旧 PGID 强杀或释放占用。这个入口是 Host/Runner 装配边界，不新增 Agent 管理命令，也不自动改变 Core 恢复决策。

## 本地验证

工具链：macOS/darwin，Node 22.19.0，npm 10.9.3；受测基线 `167c8bbd451f7fcb1e44af0dd9b336c2f8641ec2` 加本 Task 工作树改动。证据记录 `sourceDirty=true`，不冒充干净提交的阶段验收。

所有测试通过分配的 `nezha.dag.test_command` 助手执行，保存完整日志、真实退出码和 JSON sidecar。日志相对于 Feature workspace 的 `verifications/F-005/runtime-logs/`：

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 最终定向测试 | 6 文件、29 passed、0 failed、0 skipped；退出码 0；助手计时 6610ms | `test-sjlzb8uf.log` |
| 类型检查 | `npm run typecheck`，退出码 0 | `test-x00dzl97.log` |
| 模块边界 | `npm run check:boundaries`，468 个生产源码文件、0 诊断，退出码 0 | `test-l6vwss0r.log` |

最终测试 argv 是 `node scripts/run-tests.ts` 后依次追加四个新增测试文件及 `runtime/p06-4-f002-mcp-fake-server.test.ts`、`runtime/p06-4-f006-mcp-recovery.test.ts`。新增四文件共 21 项，直接相关旧夹具/登记表回归 8 项。其余 14 个索引文件未由 Runtime 执行，交 Nezha 独立复验。

RED/调试日志保留：`test-fzdsdkca.log` 是尚未实现迟到回包模式的 RED；`test-wtly9sbj.log` 揭示初版强杀夹具因 stdin 结束自动退出，需要显式保活才能验证 orphan 路径；`test-weihc6wa.log` 是接口错误码预期与实际 `invalid_input` 不符的夹具断言修正。`test-xgthm_1v.log` 是新增测试类型注解问题，已修复。它们均未覆盖或标成成功，不将夹具失败称作生产缺陷证据。

## 独立回归与报告材料

仓库唯一 Task 范围：`test/index/phases/P06/features/P06-7/tasks/F-005.json`（20 个文件，含精确 case 选择），已接入 Feature 索引。Harness `verifications/F-005/test-selection.json` 只引用仓库索引；Task/project/schema、路径及稳定 case ID 已核验。

结构化材料位于 Feature workspace 的 `verifications/F-005/evidence-final-20261029-0810/`：

- `first-and-resume.json`：两次执行的输入资源、实际 manifest、SDK 工具结果、进程与事件身份。
- `interface-authorization.json`：独立接口授权与无副作用证据，不含凭据。
- `runner-kill-host-rebuild.json`、`recovery-*.json`：真实 OS 进程和 SQLite 隔离事实。
- `late-response.json`、`startup-*.json`、`call-*.json`、`cross-project-handle.json`：故障分类和实际调用事实。
- `evidence-manifest.json`：14 份材料的 SHA-256、受测身份与最终进程清点。检查 17 个受管 PID、14 个进程组，均无遗留。仅覆盖本轮保存身份。

资源清单、接口授权与 OS 事实分别保存。可信项目模式不提供强 OS 沙箱；本轮没有验证同用户 shell 无法读取其他文件。模型输出由内存脚本提供，未调用真实模型或远程 MCP。真实 live、全仓/组合门禁、构建、Feature task_union 与 Phase 验收均为 not_run，由各自授权入口执行。本 Task 不修改官方 Task/Feature 元数据，不签署 P06。
