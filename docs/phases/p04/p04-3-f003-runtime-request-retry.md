# P04-3 / F-003：真实请求重试、部分证据与结算交接

F-001 分类与 F-002 决策器已接入标准 Pi SDK 的 `Agent.streamFunction`。重试只重发一次模型请求；不重跑 `prompt()`、工具、Runner 启动或 Task 探索。Core application 提供唯一有界循环，Host 负责实际 transport、可取消等待和 SDK 事件桥接。

## 实现边界

- 一个 Work Runner 共用一组请求/故障计数。默认最多 2 次重试、共享上限 2，退避基数 250ms、上限 2000ms，使用当前 Session 的绝对 deadline。请求成功只清连续失败数，保留累计失败和峰值；拒绝并行请求。
- Work Session 关闭 Pi 自动重试，每次 provider 请求强制 `maxRetries: 0`。临时连接/服务故障且未出现内容或工具增量才允许重发。timeout、工具、取消和未知故障不推断为可安全重放。已有增量、部分结果、Runner 不存活、取消或 deadline 均停止。
- 重发保持原 model/context/options、invocationId、executionVersion、输入快照和资源身份。每轮 request/failure/backoff/success/stop 经 `pi.retry.*` diagnostic 进入现有事件身份与水位；字段 `n/r/f/peak/fm/bm` 分别记录请求数、重试数、累计故障、连续峰值、失败耗时、退避耗时。
- 包装层读取有限的 transport cause 链，支持 `fetch failed -> ECONNRESET`。只把最终 terminal 交给 Agent；被重试抑制的 `start` 不创建额外 assistant 消息。失败轮 usage 在下一轮真正开始时单独发布；最终失败由正常消息路径发布，避免重复。
- SDK 强制要求的合成零 usage 带不可用标记，Core 桥接保持 `null`。SDK 的 usage 计量/完整性无法确定时继续为 `unknown`；observations 的已知总和不声称是可结算费用。
- 未识别 SDK terminal 归为 unknown，向 Agent 输出受控 error，禁止误报 completed。控制器异常、取消与 deadline 同样不能变成成功。
- 结算保存 F-001 classification，按既有 authentication/configuration/rate_limited/provider/protocol/process/timeout 类型投影，保留 unknown 分类及原有控制事实、停止证据与 recording 状态。Adapter 不操作 Core 业务表、预算或 Task 状态。
- Recorder 在事件流异常时，尽力落盘已接受、仍在有界缓冲中的事件和 usage，再生成 `coverage: failed` 清单。原始故障保持不变，写入失败留下缺口，不伪造完整性。
- 沿用既有 fencing、幂等与资源隔离；stop 未确认保留占用。SDK idle 仍不能充当 OS/工具资源停止证明。idle 未确认时保留已取消的请求包装，阻止迟到 SDK 请求绕过预算。
- 自定义旧 Session 不提供标准请求边界或关闭自动重试能力时，保持原适配行为，不安装新的请求循环。Chat 不安装该 Work 包装。

## 本地实跑

最终代码仅运行两个新增的 task-local 文件，共 **23 项通过，退出码 0**：

1. `test/modules/runtime/p04-3-runtime-request-retry.test.ts`：9 项，覆盖共享上限、成功重置、退避取消、部分输出、Runner/deadline、同 context/provider retries、嵌套 transport cause、非法策略、并行请求和控制终态。
2. `test/modules/runtime/p04-3-runtime-retry-settlement.test.ts`：14 项，使用真实标准 `AgentSession` 和可控 transport，连接 SQLite ExecutionService、Recorder、Settlement。覆盖两次 503 后成功、单 Session/Attempt/启动预算、三轮 usage、断流、认证、配额、耗尽、timeout、取消、unknown、采集/事件流故障、缺失 usage、未知 SDK terminal、重复结算与过期 executionVersion。

真实 SDK 测试使用本地合成凭据和可控 stream，不调用远端模型。独立进程停止证明与实际网络供应商行为仍由受影响回归/后续验收验证。

日志根目录：`/Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-20-12-01-22_p04-3/verifications/F-003/runtime-logs/`。

| 验证 | 日志 | 结果 |
| --- | --- | --- |
| 最终两个 task-local 文件 | `test-qxl54wb0.log` | 23 passed，exit 0 |
| 最终 `npm run typecheck` | `test-use_gnci.log` | exit 0 |
| 首次控制器 RED | `test-4j_kous_.log` | 新 application 模块不存在 |
| 结算分类 RED | `test-9g7sxth6.log` | 原结算缺 classification，断流被当作 process |
| 嵌套 transport cause RED | `test-t2uiy4ci.log` | 原实现只请求一次，未识别嵌套 ECONNRESET |
| 事件流部分证据 RED | `test-5e8sj90x.log` | 失败清单 usage 为 0，缓冲事件未落盘 |
| 未知 SDK terminal RED | `test-dftdavw8.log` | 原实现把未知 SDK terminal 当作 completed |

其他调试失败与中间通过日志仍保留在同一目录，最终证据以上表为准。类型检查还暴露既有 `p04-1-pi-f007-contract.test.ts` 对 unknown 结果直接访问属性；改为等价的 `toHaveProperty` 断言，未弱化该用例。

## 交 Nezha 的受影响回归

唯一范围源是 `test/index/phases/P04/features/P04-3/tasks/F-003.json`，Harness 的 `verifications/F-003/test-selection.json` 引用此索引。已检查 task_id、v2 schema、16 个路径存在且均在允许的模块测试范围内。

其中上述 2 个文件已本地实跑，其余 **14 个文件仅登记，未在本 Runtime 执行**：F-001/F-002、Pi adapter/Runner/stopping/contract、资源访问集成、ExecutionService、Runtime contract/session/settlement/uncertainty、Recorder 与恢复负例。由 Nezha Verifier 执行受影响回归。本地未运行全量、组合门禁、Feature 或 Phase 验收；任务报告不代表独立验收通过。
