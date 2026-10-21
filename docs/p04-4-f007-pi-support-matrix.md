# P04-4 F-007 标准 Pi 恢复能力支持矩阵

## 适用范围

本矩阵描述标准 `@earendil-works/pi-coding-agent@1.0.4` 通过受信 Host/Core 组合根接入时的恢复事实。标准 Pi 的生产默认 descriptor 是 `PI_RUNTIME_RECOVERY_DESCRIPTOR`：适配器版本 `0.1.0`，原生格式 `jsonl`/`3`。该 descriptor 不把 SDK 的持久化文件等同于 Core 执行恢复。

状态含义如下：

- `verified`：有受控测试或组合根事实证明该边界，证据引用可追溯；不表示真实模型环境已经验证。
- `unsupported`：当前生产装配明确拒绝该能力，并保留原因和限制。
- `unverified`：没有可信 descriptor 或来源证据，Core 不能授权恢复。
- `not_run`：需要真实认证、真实模型、外部 provider 或人工实验，本任务没有运行。
- `partial`：只收到受限恢复记录或部分事件，不能升级为完整恢复证明。

## 能力矩阵

| 能力或边界 | 标准 Pi 生产状态 | 证据/原因 | 允许的消费方 |
| --- | --- | --- | --- |
| `nativeHistory` | `unsupported` | 未暴露经过 Core Artifact 核验的原生历史读取器 | Session 查询只展示 descriptor 状态 |
| `conversationResume` | `unsupported` | 未验证同 Task 会话加载与继续操作 | `auto` 降级为 `new`；`required` 拒绝 |
| `executionRecovery` | `unsupported` | Pi Session 持久化不是 checkpoint、工具执行或副作用恢复契约 | Core 不把会话续接当执行恢复 |
| `modelSwitchOnResume` | `unsupported` | 未验证恢复时 provider/model 切换 | `required` 拒绝；不推断兼容性 |
| `nativeFork` | `unsupported` | 未验证不可变来源 fork 与单写入者交接 | `auto`/`required` 均不能伪造恢复成功 |
| SDK 版本与原生格式声明 | `verified` | `1.0.4`、`jsonl`、`3` 在 descriptor 中固定 | Recorder、诊断查询 |
| Core `auto`/`required` 决策 | `verified` | `decideRuntimeRecovery` 与恢复组合根测试 | Core Runtime Recovery Service |
| Artifact 来源、Task/Attempt/fence 核验 | `verified` | `RuntimeRecoverySourceReader` 为可信内部端口；来源不是客户端路径 | Core 恢复预检与受管 Pi 来源管理器 |
| 恢复记录字段边界 | `verified` | 仅传递 invocation、决策、来源摘要、模型、watermark、gaps 等受限事实 | P04-5 Recorder、P04-7 Runtime Control |
| FakeRuntime 生产 Pi 证据 | `unsupported` | Fake 只由测试脚本装配，不注册 Pi descriptor 或原生来源 | 仅测试恢复矩阵，不提升 Pi 状态 |
| 无 descriptor 的 Runtime | `unverified` | Core catalog 缺失时能力未知 | `auto` 只能按 Core 策略新建；`required` 拒绝 |

## 未运行实验

以下项目保持 `not_run`；本任务没有调用真实 provider、真实认证、付费模型、跨 provider 或换模型实验：

- 真实认证下的同 Task 真实模型会话续接：`not_run`。
- 恢复时 provider/model 切换：`not_run`。
- 跨 provider、跨版本 JSONL、断电或 SIGKILL 后恢复：`not_run`。
- 外部工具副作用 exactly-once、Token 节省和缓存收益：`not_run`。

离线 FakeRuntime、受控 Pi sessionFactory 和 Artifact fixture 的 `verified` 只约束协议、身份、停止核验、去重和脱敏边界。它们不能把标准 Pi 的五项生产恢复能力改成 `verified`。

## 组合根规则

`startHost` 接收可信的 `runtimeRecoveryDescriptors` 与 `runtimeRecoverySources`，并将它们原样注入 `openCoreApplication`。当能力目录声明 `pi` 而没有显式 descriptor 时，Host 装配标准 Pi 的上述默认 descriptor；没有 `pi` 时不创建 Pi 恢复条目。来源读取器缺失时，Core 保持 `source_reader_unavailable` 的拒绝行为。

Core 继续拥有预算、资源锁、fencing、停止核验、Verifier 和人工验收。恢复决策或 Runtime result 不会直接写入 Task `passed`，也不会绕过 `executionStart`、`executionStopControl`、`verificationStops` 或既有验收状态机。
