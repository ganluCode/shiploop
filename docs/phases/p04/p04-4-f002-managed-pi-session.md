# P04-4 F-002：标准 Pi 受管会话交接

锁定 `@earendil-works/pi-coding-agent@1.0.4`，原生 JSONL 格式为 v3。实现使用标准 Node SDK `SessionManager.create` / `SessionManager.forkFrom`，没有依赖 CLI RPC API。

## 已实现边界

- `new` 从未存在过的受管目录创建新原生 Session；原子 `mkdir` 拒绝两个工厂认领同一目录。不同授权范围取得不同原生身份，工作目录代码不会重置。
- conversation 来源只能属于同项目、Feature、未完成 Task 的直接上一 Attempt/Session。可信 source manager 原子取得独占写入者权限，绑定当前 Session、Attempt、invocation、executionVersion 和 owner，并提供 `assertCurrent()` 重核资格与所有权。
- 加载前验证 Artifact 项目、标识、内容摘要、字节数及媒体类型，核对 SDK 版本、格式版本、原生 Session 身份、停止确认和停止证据 Artifact。来源字节来自可信 Artifact verifier，不读取旧 Runner 的活动档案路径。
- 仅接纳有界 UTF-8 JSONL：8 MiB、20,000 行，v3 header、唯一 entry ID、有效父链，以及经过结构校验的 user/assistant/toolResult 消息、model change、thinking level change。compaction、system/tool 定义修改、extension/custom 和其他复杂状态返回 `native_entry_unverified`，损坏格式明确拒绝。
- 已校验 Artifact 字节写入新目录的只读 `source.jsonl`（独占创建、0400），随后 SDK fork 到该目录的另一个文件。校验 fork 的新身份和目标目录；缺少 fork API 返回 `native_fork_unsupported`。保留来源快照，不打开或复制活动原生数据库。
- 创建 SDK Session 时显式传入当前获准 provider/model、resourceLoader 和 thinking level（缺省 `off`），并核对 SDK 实际值。只加载对话归档，不导入来源 agentDir、凭据、旧设置或工具授权。
- `RuntimeHandle.nativeSession` 返回实际 providerSessionId/文件、格式、适配器/SDK 版本，以及 resume/new 决策、来源、能力证据引用和当前模型/推理事实。仅返回事实，不直接更新 Core SQLite、预算、资源锁、Task passed 或验收结果。
- 读取 Artifact、创建 fork、构造 SDK Session 和开始 prompt 前均核对当前所有权。SDK idle 未建立时保留 adapter writer ownership，外部进程停止确认仍由既有 Core/Host 流程负责。

## 装配与后续任务

`PiTrustedAssembly.recoverySourceManager` 是可信 Host/Core 注入端口，必须保证 acquire 的原子独占和当前资格核验；不能把 prompt/SDK 输出或任意路径作为来源。`PiRecoveryWriterLease.readVerifiedArtifact` 必须复用现有受管 Artifact 读取/完整性核验，`assertCurrent` 必须拒绝已完成 Task、已替换 owner/fence 和不再是直接上一 Attempt 的来源。`release` 仅释放 adapter 权限，不替 Core 释放业务占用。业务选择与持久化接线由后续任务继续，当前任务没有绕过 Core 自行查询/写入业务表。

生产默认五项恢复能力仍为 unsupported。具备环境证据的可信装配可提供 `recoveryCapabilities`；版本和身份必须匹配，checkpoint execution recovery 不允许声明 verified。离线测试的 conversation/model/fork 证据仅作用于受控测试装配，不提升生产能力，也不证明真实模型续聊、跨模型/跨供应商协议兼容或缓存收益。

Core 纯恢复决策负责 required 拒绝和 auto 降级原因。auto 带来源时仍先验证该来源，损坏、越界、版本不兼容或停止未确认不会被新 Session 掩盖。没有可信 source manager 时明确拒绝。失败时目录保留且不重新认领，避免复用身份不明的写入范围。

## 验证证据

完整日志和真实退出码 sidecar 位于当前 Feature workspace 的 `verifications/F-002/runtime-logs/`：

- 初始 RED `test-dqjk1j6y.log`：原生版本常量误标为 1，期望真实 v3。
- 三份聚焦文件的 `test-l69q_y31.log`：53 passed，0 failed，0 skipped。随后增加停止不确定用例，发现测试误用了结果字段 `status`（实际契约是 `terminal`），保留诊断日志 `test-f0318f2b.log`；修正后仅重跑受影响文件。
- 最终 managed session 文件 `test-ye8o65y0.log`：37 passed，0 failed，0 skipped；此前相邻 adapter/boundary 两文件 17 项通过，未在测试字段修正后无理由重复执行。共覆盖三个文件的 54 个用例。
- `test-uylhgsiq.log`：typecheck exit 0。
- `test-jpbdacb8.log`：边界静态检查 exit 0，313 个生产源码，0 diagnostics。

任务索引 `test/index/phases/P04/features/P04-4/tasks/F-002.json` 登记 10 个文件。上述三个文件本地已测；另外七个 Runner、恢复装配/驱动和 Session 契约回归仅登记，交 Nezha 独立执行。没有运行全量测试、组合门禁、Feature/Phase 验收或 live 模型。
