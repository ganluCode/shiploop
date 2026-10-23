# P04 真实 Core 探针：原生 Pi 用量范围修复

2026-10-23，`ark-agentplan/ark-code-latest`，Pi SDK 1.0.4。真实探针经过 Core 的
持久派发、Task 认领、受管工作区、受监督 Runner、Pi SDK 和同步受限写文件工具。

## 暴露的缺陷

真实 SDK 发出两条 assistant 回复并完成写入，Runner 与 Session 均停止，但
`usageOf()` 把所有 Pi 消息用量无条件标为 `accounting=unknown`。required Recorder
据此留下 `usage_scope_unknown` / `recording_scope_incomplete`，Attempt 为 failed，
Run 为 paused。**失败关闭是正确的，适配器缺少原生 SDK 的用量语义识别才是缺陷。**

失败证据保存在 Harness：
`state/acceptance/p04-core-live-2026-10-23T06-53-52-639Z/`。
首轮更早的输入装配错误零调用现场另行保留，不与真实模型失败混为一谈。

## 修复边界

- 仅当 Session 为真实、锁定 **1.0.4** 的 `AgentSession` 实例时，识别其成功/工具/
  输出限制终态的每回复用量为本次请求增量；不是根据 LLM 输出自报或 provider 名字猜测。
- 依据安装包 `pi-ai/dist/api/openai-responses-shared.js` 的 `finalizeResponse`：
  当前 response.usage 写入当前 assistant message；input 已扣除 cacheRead/cacheWrite。
- 保留缓存读取、写入、推理和供应商总量等可得原始维度；缺失值仍为 null，coverage
  和 completeness 仅为 partial，不声称供应商完整账单。
- 自定义/伪造 Session、未核验 SDK 版本及失败/中断占位用量仍保持 unknown。
- 不关闭 required Recorder，不清除旧 gap，不将已失败 Attempt 手改为通过；
  Pi 的原生持久化/SDK idle 仍不能代替外部工具进程停止证明。

## 验证

新增真实 SDK + 离线受控 stream 回归先失败（unknown vs incremental），修复后
连同既有适配、重试、续接、录制回归 **5 文件、82 项全部通过**。这些是离线测试，
不冒充真实 Core 重验。T41 的补充证据绑定纳入此回归。

真实 Core 是否已在修复后通过，必须读取最新一次独立 live 结果；本修复记录本身
不代替重验、不代签阶段放行。历史失败和临时数据均保留。
