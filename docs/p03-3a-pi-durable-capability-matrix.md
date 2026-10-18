# F-004: Pi Durable 版本锁定实验与 P04 决策

## 决策

**P04 保留标准 Pi SDK 作为默认接入路径；Pi Durable 1.2.0 仅保留为显式、可关闭的实验候选，不替换当前生产能力目录。**

Durable 的 SQLite 检查点和请求去重确实工作，但不能提供业务幂等、外部副作用 exactly-once、原生档案跨进程排他或非协作工具强制停止。恢复 `execute` 阶段不会重跑 `beforeTool`，也不能把该 hook 当恢复授权检查。标准 Pi 更贴近现有本机认证、资源发现和插件体系；这只是接入复杂度判断，不代表标准 SDK 已通过生产恢复验收。真实认证/模型测试仍为 P04 门槛。

本任务只增加独立实验、测试入口和证据，不实现 P04 Runner、Recorder、Skills/MCP 桥接，不修改 F-001/F-002/F-003 实现或 Core 依赖。

## 可复核基线

- 前置代码：`e00f9834769c6e6915ae4a2c386553ceea6b0e4a`；实验实现以包含本文的 F-004 Git 提交为准，可用 `git log -- experiments/pi-durable` 查找。
- npm 候选：`@earendil-works/pi-durable@1.2.0`，`pi-ai@1.2.0`、`chord@1.2.0`；全部传递依赖由独立 `package-lock.json` 固定。不在根 workspaces 或生产依赖内。
- Node `22.19.0`、npm `10.9.3`、内置 SQLite `3.50.4`。`.nvmrc`、`engines`、`.npmrc` 与 probe 运行时检查共同锁定环境；Node SQLite 本身仍有 ExperimentalWarning。
- 官方 README 标明 **Experimental，API 可在 release 间无通知变化**，不能泛化为其他版本已验证。
- npm tarball integrity、参考 tag `v1.2.0` 对应 commit、官方 spec URL/SHA-256、lock SHA-256、执行命令和退出码见 [sources.json](../experiments/pi-durable/sources.json)。npm 未提供 `gitHead`，因此不冒称该 tag 就是 npm 的已验证构建 commit。安装 lock 的 resolved URL 使用本机 npm 镜像，其 integrity 与官方 npm 元数据一致。
- 本机标准 Pi `@earendil-works/pi-coding-agent@1.0.4` 只读文档/类型参考，**不是 Durable 通过证据**，两版本间桥接未执行。
- 实测记录 [evidence.json](../experiments/pi-durable/evidence.json) 保留原生任务版本/检查点、工具结果、真实进程退出信号、文件副作用次数和事件类型。时间戳、耗时会随复跑变化。

## 复跑

从仓库根目录执行，须先使用指定 Node/npm：

```sh
npm ci --prefix experiments/pi-durable --ignore-scripts --no-audit --no-fund
npm test --prefix experiments/pi-durable
node experiments/pi-durable/probe.mjs > experiments/pi-durable/evidence.json
SHIPLOOP_PI_DURABLE_SPIKE=1 node scripts/run-tests.ts test/modules/runtime/recovery/p03-3a-pi-durable-spike.test.ts
```

安装需要访问 npm registry；实验执行本身不需要网络、模型凭据或订阅。使用官方 `fauxProvider` 和真实 `Harness`/SQLite，而非自写恢复状态机。`createModels()` 默认仅内存凭据，唯一注册 provider 是 faux；不调用标准 SDK 默认资源发现，不打开本机 `auth.json`/MCP 配置，不读取或复制真实密钥。子进程使用环境白名单。受控工具只修改临时目录；遗留进程用 PID 显式清理，全部有超时，非协作测试在有界观察后主动释放。

项目测试入口通过一个 opt-in Vitest 包装执行 **14 项真实 SDK 断言**。普通 `npm test` 只检查版本隔离，不安装/加载实验 SDK；不设置 `SHIPLOOP_PI_DURABLE_SPIKE=1` 时的跳过不算真实 SDK 通过。本任务 affected 验证设置了该变量。

TDD：首先缺少 `probe.mjs` 的 RED 退出 1；首次检查点断言 7 通过/6 失败，发现 SQLite 索引字符串使用 JSON 编码，修正取证 SQL 后 13 项 GREEN；再加入外部遗留进程测试，项目入口实际执行 14 项通过。早期 RED 仅存在会话工具输出，未伪造补写原始日志；命令与退出码保存在 sources，最终验证日志在 Feature workspace `tool-logs/F-004-*.log`。

最终 affected 为 8 文件/276 项通过。首次 full verify 因 Vitest 意外收集 Node 原生测试及既有 sentinel 时序用例失败而退出 1；原生测试改名为 `probe-tests.mjs` 并仍由包装入口显式运行，既有用例未改、单独复跑通过。最终开启 SDK opt-in 的 full verify 为 188 文件/4085 项、typecheck/build 全部通过，边界扫描 139 文件/0 诊断。这些工程检查不替代 F-006 独立验收。

## 真实 SDK 能力矩阵

状态含义：`verified` 仅在指定版本、faux provider 与受控本机条件下成立；`unsupported` 表示目标保证缺失，有负向实测/接口证据；`not_run` 表示没有执行所列范围。测试通过可以验证负向结论，不等于该能力受支持。

| 能力/目标保证 | 结果 | 证据与限制 |
| --- | --- | --- |
| 持久化会话历史、重开读上下文 | verified | duplicate 重开；storageAndEvents 的 SQL 快照及关闭后复制均读到 8 entries |
| 同 conversation 的 requestId admission 去重 | verified | 相同 submission ID，1 个 user entry，首次 provider 调用 1 次，重开重试调用 0 次 |
| requestId 内容冲突拒绝/业务幂等 | unsupported | `conflictingPayloadSame=true`：不同内容仍返回旧 submission；不是 Core Attempt/预算/业务命令去重 |
| provider sessionId 重开延续 | verified | duplicate 新请求仍接收相同非空 sessionId；不等于调用不会重发 |
| 工具前中断 | verified | SIGKILL 于 beforeTool 内：`pi.tool` v2 checkpoint=`call`；恢复 hook 共 2 次、文件 effect 1 次 |
| 执行意图已存、工具效果已写但结果未存 | verified（有条件恢复） | checkpoint=`execute`、原参数/replay 已存；unsafe 不重跑，返回 `interrupted`，副作用仍 1 次 |
| 工具已返回、afterTool/结果提交前中断 | verified（有条件恢复） | unsafe effect 1 次、after hook 1 次，恢复仍为 interrupted；不能据此断言外部 effect 已完成 |
| safe 声明提供副作用 exactly-once | unsupported | execute 与 afterTool 两个窗口的 safe 恢复均 effect=2；工具声明不会自动使效果幂等 |
| 结果提交后的工具不重跑 | verified | 在后续 generation 调用处 SIGKILL；tool task terminal，恢复 effect=1、结果 entry=1 |
| 恢复 execute 重跑 beforeTool 授权 | unsupported | safe 恢复 effect=2，但 beforeHooks=1；重验证必须进入工具 execute/受控 env 且受 Core fencing 约束 |
| 缺失遗留工具 | verified（降级为错误） | 存储 safe 意图，重开不安装工具；effect 不重跑，interrupted 结果，liveTasks=0；非“成功恢复” |
| 取消等待即停止任务 | unsupported | wait context 取消会拒绝 waiter，tool 及 live tasks 仍运行 |
| Conversation.abort 协作取消 | verified | 工具收到 signal 并退出；返回后 liveTasks=0，仅覆盖本 SDK 的普通 ownership scope |
| Harness.close 协作退出 | verified | close 等待工具退出；不会当作成功终态，也不是全 OS 进程树停止证明 |
| 非协作代码被 close 强制停止 | unsupported | 工具忽略 signal 时 close 仍 pending；实验手动释放后才完成；官方 spec §12/§13 同样声明此限制 |
| SIGTERM/SIGKILL 后重开 | verified（普通进程故障） | 确认主进程已退出后重开；SIGTERM 无自装 handler，不冒充正常 SDK abort；unsafe 结果 interrupted |
| 主进程强杀意味着外部工具全部退出 | unsupported | 受控 detached worker 在父 Harness SIGKILL 后仍存活并继续写；probe 显式 SIGKILL 清理且观察输出停止 |
| 同档案单原生写入者强制 admission | unsupported | storageAndEvents 在第一 Harness 仍 open 时，另一个真实进程成功 Harness.open/root/close，exit=0；未测试并发调度，不能共写 |
| SQLite 布局/格式版本 | verified | `native.sqlite` + open 期间 `-wal`/`-shm`，关闭后只保留 main；`durable_schema.version=1`，JSON records、document_revisions base/delta；字段索引使用 JSON 编码 |
| SQLite 在线一致快照 | verified（应用控制） | 第二 SQL connection 执行 `VACUUM INTO`，重开备份可读；不是 Durable 自带 archive/backup API，也未验完整 live backup/fencing 工作流 |
| 关闭后的物理复制 | verified | 所有当前 handle 关闭后 copyFile，重开与 SQL snapshot entry 数一致；不能裸复制仍打开的 main 文件 |
| 自动可移植备份/恢复/向前格式兼容 | not_run | 跨版本升级/降级、损坏库、电源故障、远程文件系统及完整归档流程未执行；不存在由本实验证明的可移植 promise |
| JSONL backend 实际持久化 | not_run | 仅官方 README/spec §11.3 静态核对：`main.jsonl` + documents；默认不承诺掉电 durability，未执行该 backend |
| 原生事件与重新挂载 | verified | watchEvents：snapshot/run/turn/message/tool events；工具事件有 toolCallId 与 taskId；重挂得到完整 snapshot、tools=0 |
| 原生事件是可靠可按 offset 重放 journal | unsupported | spec §9.4：断开后从 snapshot 重新挂载，不 replay；overflow 可替换为 snapshot。本实验未测 overflow，不把 event count 当连续水位 |
| 空闲后的模型切换 | verified（faux 同 provider） | 配置 faux-2、tools=[]，实际 dispatch faux-2；pi.provider identity 保留，配置在复制后的库仍可读 |
| 已准备 generation 的模型改变/跨 provider 恢复 | not_run | spec §7.4：prepare 后 model/prompt/tools 固定到该 request，configure 从下个 request 生效；没有执行真实或跨 provider 兼容性 |
| 原生 fork | not_run | 存在 Conversation.fork(at, options, context)，spec §3.7；未做真实 SDK fork 断言，不能由 F-003 Fake fork 推为 verified |
| 实际模型 token、费用、订阅及缓存收益 | not_run | faux usage 为零；没有实际认证/计费/缓存实验，也不声称节省 Token |

### 与 F-003 Fake 结果分列

| F-003 Synthetic 协议夹具 | 真实 SDK 对照 |
| --- | --- |
| 可识别文件效果幂等重放，未知效果隔离 | 原生 safe 会重放效果，unsafe 给 interrupted；识别/核对/隔离仍是外层责任 |
| 两个原生写入者被夹具排他锁拒绝 | Durable 未拒绝第二进程打开；夹具锁不是 SDK 能力 |
| 持久前缀事件水位与冲突检测 | watchEvents 是 snapshot + commit batches，没有原生 replay offset |
| conversation/checkpoint fork 及不可变来源 | Durable API 有 fork，但本次实际 fork 未测；Core Artifact 来源约束不能由原生 session 替代 |
| 用量范围/父子防重算、partial/unknown | 未执行真实模型用量；不能以 faux 零值证明这些保证 |

F-003 测试继续约束通用 Core 契约；F-004 不修改或放宽这些要求。

## 认证、插件及资源桥接核查

下表均为官方导出/本机只读文档的静态核对；没有调用认证方法、扫描真实用户资源或连接 MCP。

| 接口面 | 标准 Pi 本机 1.0.4 | Durable 1.2.0 | 接入判断 |
| --- | --- | --- | --- |
| 本机认证复用 | ModelRuntime.create 可显式传 authPath/credentials、modelsPath；默认文件认证及模型组合 | HarnessOptions.models 接受 pi-ai Models；createModels 默认 InMemoryCredentialStore，不加载 Pi 用户认证 | ModelRuntime 声明 implements Models，结构上存在复用方向；1.0.4/1.2.0 兼容与 OAuth 刷新 **not_run**，不得复制密钥或默认触发认证读取 |
| 模型插件 | ExtensionAPI.registerProvider + ModelRuntime.registerNativeProvider/registerProvider；含兼容 provider config/virtual routing | models.setProvider(Provider)，registry.install 是 Durable extension，不是标准 Pi ExtensionAPI | 纯 pi-ai Provider 可作为桥接单位；标准扩展 factory、legacy config、virtual model router 不能直接视为可用，需可信白名单桥接；实际插件 not_run |
| 选择性 Skills | DefaultResourceLoader.skillsOverride，SKILL.md metadata + 按需正文读取，受发现和 trust 约束 | defineExtension 的 sections、agent.extensions/tools/modelTools；spec 示例 Skills 需 host 实现 | 提示段可桥接，但没有等价的标准 ResourceLoader/skills loader；选择性资源发现/版本快照需实现，not_run；不能加载所有本机 Skills |
| 选择性 MCP | createMcpExtension，bindExtensions/session_start 才连接；用户/受信项目配置、exposure 和 tool allowlist | tool callers/deferred/modelTools、tool_search/codemode、executeTool 可承载 MCP 包装；无标准 MCP 配置/认证/连接管理接口 | expose 工具不等于连接生命周期/trust/资源接口已桥接；stdio/HTTP/auth/shutdown 全部 not_run，禁止自动连接本机服务 |
| 受控工具 | 标准 SDK 工具/扩展执行和 session hooks | defineTool execute(args, api, Context)，结果分 output/structuredOutput/details，replay 与 beforeTool/afterTool | 本实验定制工具 verified；标准工具定义和事件不能原样传入；恢复必须在 execute/env 再核授权，安全 guard 不能被 extension 选择遗漏 |
| 记录接口 | SessionManager 的 JSONL entry tree、AgentSession subscriptions/dispose | Session commit、entries/context、watchEvents、pi.live、pi.usage、Chord watches；原生 SQLite schema | 非同一格式或事件协议；工具 identity 需加 Core invocation/Attempt 和 fence，快照不能算新执行，history 不能算新回复；真实 Recorder bridge not_run |

静态证据：标准 Pi `docs/sdk.md`、`custom-provider.md`、`skills.md`、`mcp.md`，`examples/sdk/04-skills.ts`、`09-api-keys-and-oauth.ts`、`14-codemode-mcp.ts`，以及 `dist/core/model-runtime.d.ts`；Durable npm 导出的 `dist/harness/types.d.ts`、`events.d.ts`、`storage/sqlite/migrations.js`/`storage.js`/`node.js`；pi-ai `dist/models.d.ts`、`auth/credential-store.d.ts`、`providers/faux.d.ts`。这些可按锁定版本重新安装查阅。

## P04 门槛与 Core 边界

1. 默认标准 Pi SDK 也要锁定候选版本，并经用户明确授权再验证真实认证、模型/插件组合、usage scope 和跨模型 transcript 兼容；not_run 不可转为 verified。
2. 若选择 Durable opt-in，先实现原生单写入者占有/fencing、版本化不可变 Artifact 快照和一致备份；原生库与 Core SQLite 分开，不能共写或将可变 session 路径当恢复来源。
3. 外部工具的授权、预算及幂等凭证由 Core 的 Attempt/invocation 决定，在 execute/env 恢复入口再次核对；requestId admission 去重不会创建/退还额度，也不能证明业务执行只一次。
4. 停止确认必须覆盖外部进程及 MCP/环境资源；超时、不可确认或晚到结果隔离，不能在仅收到 cancel、SIGKILL 父进程或主进程重开后释放占有。
5. Recorder 桥接需要稳定身份、不可变记录、水位/断流状态及 explicit usage coverage。Durable snapshot、重复历史、父级汇总和子工具 usage 不能混作新增事件或重复计费；原生 terminal 更不等于 Core Task passed。
6. 在资源白名单、Skills/MCP trust、插件兼容、真实模型和上述停止/恢复门槛满足前，Durable 不注册 production `executionRecovery=verified`；标准 SDK 也不能宣称检查点执行恢复。

相关通用协议仍以 [Runtime 恢复契约](p03-3a-runtime-recovery-contract.md) 与 [Synthetic 夹具边界](p03-3a-synthetic-recovery-fixtures.md) 为准。本结论不等于 F-005 文档兼容交接或 F-006 独立 Feature 验收已完成。
