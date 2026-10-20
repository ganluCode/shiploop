# P04-3 F-007：故障路由接线与确定性验证

## 组合根行为

可信 `WorkRuntimeFactory` 可以提供 `failureRouting.select/authorize`。准备 Task 时校验并复制获准的备用计划，preferred 必须与 Task 已冻结的策略一致，最多 32 个备用候选。不从 settings 动态加载 Runtime，也不把函数或授权凭据写入 Task。

Work 执行只有在以下事实同时成立时才进入备用决策：结果为 failed、事件记录完整、停止已确认、当前 fence 的失败结算已持久化且回执为 applied。失败结果允许在既有 2 秒 drain 上限内排空终端事件；取消、超时、关闭仍立即中断收集。失败分类与有限请求重试沿用 F-001～F-003，不能重新执行 Runner、prompt 或工具来实现同 Attempt 重试。

路由先检查候选能力及授权，再对选中策略执行可选推理预检，并重新检查授权（单次观察最多 2 秒）、停止证据、工作区和关闭状态。切换事务核对旧 Attempt、Task fence、控制状态、预算和 lease/deadline，创建新 Attempt 后转移占用。仅允许恢复没有用户暂停意图的 `paused/runtime_failed`；paused/pausing/cancelling/interrupted 等其他控制状态拒绝。事务失败会回滚自动恢复、占用及所有新计数。

备用预占与实际 admission 共用 `runtimeStartReservationKey(attemptId, executionVersion)`，每个新 Attempt 只计一次 Runtime start。下一次执行读取自己的备用策略快照；原 Task 配置保持原值，其他 Task 仍从自己的 preferred 开始。备用链只保留选中候选之后的部分，全链失败会暂停，不循环。路由拒绝原因以有界 token 记录于当前 Run，用户暂停和旧 fence 的现场不被覆盖。

没有 `failureRouting` 时仍沿用原执行与留存路径。只有可信启动装配显式提供批准计划，才启用自动备用。

## SDK 多层重试边界

验证对象是安装中的 `@earendil-works/pi-coding-agent` / `pi-ai` **1.0.4**，不是旧 Durable 实验。确定性测试使用实际 Pi Anthropic API 和替换的 `fetch`，没有真实模型或真实凭据。

| 层 | 当前边界 | 证据 |
| --- | --- | --- |
| AgentSession | Work 请求接入时调用 `setAutoRetryEnabled(false)` | Pi settlement 集成测试断言实际注入 Session 的 autoRetryEnabled=false |
| Anthropic/OpenAI 原生 SDK | 安装版本的 Pi 适配器构造客户端时设 `maxRetries: 0`，由 Pi 的 provider retry wrapper 控制请求重试 | 安装包源码；Anthropic 另有实际 fetch 计数 |
| Pi provider wrapper | 未包装的 Anthropic stream 设 maxRetries=2，503 时实际 fetch=3；ShipLoop 包装时强制传 maxRetries=0 | `p04-3-sdk-retry-boundary.test.ts` 的安装 SDK 实测 |
| ShipLoop 请求控制器 | 默认最多重试 2 次，仍受累计额度、取消、deadline 和进程存活约束；成功只重置连续计数，保留累计故障 | 既有 request-retry/retry 用例及本任务 SDK 实测；包装后仍为 fetch=3、requestCount=3、retryCount=2、runtimeStarts=1，而非 9 |
| 未核实的 API | 不进行外层请求重放 | 本任务新增保守边界及 Bedrock 替身：底层自行请求 3 次，外层调用仍只有 1 次 |

实际发现：Pi 1.0.4 的 `bedrock-converse-stream` 构造 `BedrockRuntimeClient(config)` 时没有读取 StreamOptions.maxRetries。因此不能仅凭传入 `maxRetries: 0` 就声称所有供应商内部重试已关闭。当前只对源码明确关闭原生 SDK 重试且遵守 maxRetries 的 `anthropic-messages`、`openai-completions`、`openai-responses` 开放外层重试。其他 API 保留正常单次调用，失败后按不确定副作用停止外层重放；其底层实际请求数及默认退避不冒充外层计数。Anthropic 的实际请求数已经测量；OpenAI 的同一配置边界依据锁定源码，未宣称做过真实 OpenAI 网络测量。

AgentSession 消息循环、工具调用及创建新 Attempt 的备用切换与请求重试是不同边界。发生内容 delta、部分结果或响应后断流时，外层控制器停止重放。无法核实停止的旧执行继续 quarantine，不能因为取消回执被接受就启动备用。

## 预检与诊断

预检继续默认关闭。开启时首选与备用各自调用 inference-only adapter，使用固定 `Reply with OK.`、maxRetries=0、maxOutputTokens=32，不传 Work 工具或工作目录。开始与结束各写一条审计记录；用量标记为 `inference_preflight`，不占 Work 的 Attempt/RuntimeStarts。TTL、取消、无授权等原有用例仍由 F-006 索引覆盖，本任务另验证备用预检失败时没有新 Attempt。

受管 Work Session 查询按 Attempt 返回结果、部分用量、recording 完整性及停止证据，并新增可选 routing 投影：当前 category、最多 32 条前序 category/reason、选中策略的 runtime/provider/model/source。凭据及 endpoint 引用不进入投影。读取与 HostClient 公共 wire 都拒绝未知字段、无效分类、过长数组和非 token 文本；旧证据不带 routing 时仍可查询。完整重试计数和退避事实保留于既有 `pi.retry.*` 有界诊断事件，详细分类/部分结果仍保存在受管结算制品中，不把原始错误正文公开给客户端。

## 本地证据与独立验收范围

所有以下日志及 `.log.json` sidecar 位于 Feature workspace 的 `verifications/F-007/runtime-logs/`，包含完整 stdout/stderr、真实退出码、超时及计数元数据。

| 本地命令（统一通过 Nezha test_command wrapper） | 结果 | 日志 |
| --- | --- | --- |
| `node scripts/run-tests.ts test/modules/runtime/p04-3-failure-routing-integration.test.ts` | 19 passed，exit 0，262859 ms | `test-mz2rliax.log` |
| `node scripts/run-tests.ts test/modules/runtime/p04-3-failure-routing-query.test.ts` | 6 passed，exit 0 | `test-wmlcekx3.log` |
| `node scripts/run-tests.ts` + SDK boundary、runtime-request-retry、runtime-retry-settlement 三文件 | 26 passed，exit 0 | `test-2dz3l_4r.log` |
| `node scripts/run-tests.ts` + runtime-fallback、execution-uncertainty、runtime-settlement、boundary-check 四文件 | 117 passed，exit 0 | `test-yxz7fle5.log` |
| 最终控制守卫修改后，仅重跑 fallback 与组合根中的 `Core 备用 Runtime 切换\|case:root-switch\|case:root-user-pause\|case:root-budget` | 5 passed，26 skipped，exit 0；不是再次完整跑矩阵 | `test-6x__d3qa.log` |
| `npm run typecheck -- --pretty false` | exit 0 | `test-fe0cekqw.log` |

组合矩阵包含首选→备用、连接/quota、未授权/撤销、停止未确认、旧 fence、启动预算、deadline、用户暂停、关闭中、候选不可用、禁止分类、全链失败、预检成功/失败/备用预检失败，以及实际受管查询及脱敏。停止未确认和旧 fence 用例明确断言 quarantine 与 Core 关闭拒绝，不伪造停止证明来清理持久占用。早期失败日志保留，测试预期修正后取得上述通过记录。

仓库索引：`test/index/phases/P04/features/P04-3/tasks/F-007.json`；Harness selection 只引用该索引。19 个文件的存在性、唯一性和 `test/modules/**/*.test.ts` 模式已核实。索引包括本地修改/验证范围，以及分类、累计重试、预检、旧查询/Recorder/执行入口、Pi 装配/停止和 Core assembly 的关联回归。表外回归未宣称本轮本地通过，交 Nezha 独立执行。没有运行 npm test、verify、全仓门禁、Feature/Phase 验收或 live 模型。
