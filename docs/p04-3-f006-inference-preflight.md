# P04-3 / F-006 可选推理连通性预检

`WorkRuntimeFactory` 可以显式返回 `inferencePreflight`；标准 Pi 工厂通过同名启动参数传递。缺省 policy 为 `enabled: false`，只调整预算也不会开启。关闭时不调用选择器、认证授权、模型传输或审计写入。

启用后，Core 在 `prepareClaim` 中先验证冻结 Task 的整体策略，再运行预检；此位置早于业务输入准备、Task 认领、Attempt 创建、Runtime start 预算扣减及工作区准备。预检失败固定阻止当前 Run 派发，原因以 `inference_preflight_*` 保存到已有调度诊断；不自动修改 settings、Task execution_config 或备用策略。

## 可信启动装配

启动代码提供 `WorkInferencePreflightAssembly`：

- `select({projectId, runId, taskId, strategy})` 同步取得已经注册的来源引用及环境/资源 SHA-256 摘要；不能加载项目资源。返回策略必须与冻结 Task 的 runtime/provider/model/credentialRef/endpointRef 整体一致。
- `authorize(selection, signal)` 核验显式推理授权、认证来源绑定及当前撤销状态。每次检查、缓存命中和成功准入前都复核；不能把认证就绪当推理成功。
- `adapter` 必须提供 `inference_only` 隔离能力。Pi 的 `createPiInferencePreflightAdapter(sources)` 仅匹配完整选择键，对不可隔离来源拒绝注册。

每个 `PiInferenceSource.resolve(signal)` 由可信认证装配提供，返回已绑定获准凭据/端点的 `model` 与 Pi `StreamFunction`。必要认证插件也必须在此注册，并保证不发现 HOME、项目配置或执行凭据命令；无法保证这一点时不得注册。凭据正文只能存在于传输闭包中。禁止直接交给 SDK 的默认认证发现链。

Pi 预检只构造一个固定 user prompt 和空工具清单，通过 Pi 的底层推理传输执行。没有 AgentSession、cwd、项目输入读取器、资源加载器、Skills、记忆、MCP、工具执行器或业务 Attempt 权限。认证来源只收到取消信号，模型传输只收到选定模型、固定上下文及有界选项。

环境摘要应覆盖 Runner/SDK/适配器版本、必要认证插件版本、受管端点配置版本和授权环境版本；资源摘要覆盖实际隔离配置/资源版本（含工具为空），认证引用需随来源版本变化。摘要只能来自不含凭据正文的描述符，不能对密钥正文做哈希作为版本。Core 的选择键包含完整策略、来源引用和这两个摘要；不包含凭据正文或模型响应。

## 判定、预算与缓存

成功需要有效 Pi `start → done(reason=stop, message.stopReason=stop)` 协议、匹配的 provider/model/api，以及非空文本。HTTP 200、进程退出 0、部分 delta、空白、`length`、`toolUse`、未知/缺失终态均不放行。任何工具调用都立即拒绝。

| 配置 | 缺省 | 允许范围 |
| --- | --- | --- |
| enabled | false | 布尔值，必须显式 true |
| timeoutMs | 5000 | 1–60000 ms |
| maxRequests | 1 | 1–3 次 |
| backoffMs | 100 | 0–5000 ms |
| successTtlMs | 30000 | 0–300000 ms，0 禁用缓存 |

timeout 覆盖认证、模型请求及退避，Host 关闭会取消预检。只对明确的瞬时连接/服务器失败重试；SDK 内部重试固定为 0，单请求输出上限 32 tokens。Pi 另限制事件数量和响应大小。超时后不接受迟到成功；失败从不缓存。TTL 使用单调时钟，成功条目只存在于本次 Core 启动范围内；按项目隔离，缓存数量有界。

## 独立审计与用量

每个请求发出前发布 `started`，成败发布 `finished`，缓存命中单独记录。记录作为项目的 `kind=inference_preflight`、`accounting=inference_preflight` 制品，通过现有 Core ArtifactStore 索引和文件端口发布，不写 Task/Attempt 消耗字段。记录包含 probeId、请求序号、脱敏完整选择、预算、分类、固定原因码、UTC 时间、单调耗时及已知用量（未知值为 null）。部分响应的累计用量可在超时/取消前采集；不存模型响应、原始异常、凭据或 headers。

审计写入失败则拒绝准入且不建立成功缓存。终态审计必须在模型超时后仍能完成，因此审计 I/O 使用既有制品发布的独立有界超时，不共用已经取消的模型请求信号。

项目成本审计可通过 `artifactStore.listArtifacts(projectId, {limit, cursor})` 分页并筛选 `kind === 'inference_preflight'`，取得独立费用事实，累计 `finished` 中的已知 request usage；不累计 started/cached，不把 null 当免费，也不混入 Task usage。请求累计用量仅在对应终态记一次，退避取消的控制记录不重复前次用量。进程硬退出时保留 started/无 finished 的缺口，不伪造成功或零消耗。

## 本地验证边界

新测试在 `p04-3-runtime-inference-preflight.test.ts` 和 `p04-3-pi-inference-preflight.test.ts`，覆盖缺省关闭、终态、隔离/认证拒绝、独立预算、退避取消、TTL/键失配、失败不缓存、脱敏、部分用量、审计故障及真实 SQLite/Core 的认领前接线。Core 接线测试在业务输入准备入口主动中止，核对预检制品已落盘且 Attempt/Runtime 计数保持为零。

受影响回归中的真实 Host 用例需要 macOS 原生写锁产物。干净工作区若缺少 `packages/host/dist/native/writer-lock.node`，先显式执行 `node scripts/build-host-lock.ts`（需要仓库规定的 Node 头文件、clang 和 macOS SDK），再执行测试；不通过移除用例、模拟锁或运行时编译规避此前提。该产物位于忽略的 `dist` 中，不提交。

P04-3 的结算写入方已保存 `execution.classification`。Work Session 读取方兼容这一可选审计信封，校验类别、原因和结构后仍按既有 result/control 展示；详细诊断留在经完整性核验的制品中。旧证据仍可读，未知字段和无效分类信封仍拒绝。

本地不发送真实外部模型请求（live: not_run）。Task 索引同时登记受影响的调度、Pi 装配/认证及边界回归，后者由 Nezha 独立执行；局部测试通过不代表全仓或阶段验收通过。
