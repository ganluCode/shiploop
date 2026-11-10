# F-014：集成授权与编码准入的衔接决策

本文件记录实现中发现的公开契约缺口和可审阅方案。方案尚未获负责人确认；不构成授权、不启动 Batch/Run/Git/模型，不解除人工 hold。F-014 的上次代码与失败证据保留。

## 当前可核对的循环

1. `packages/core/src/application/execution-preview.ts` 在成员依赖未完成或 `integration_not_ready` 时返回 blocked，且 previewDigest/summary 为 null。这一步同时作用于单 Feature 和多成员范围。
2. `packages/core/src/application/execution-start.ts` 的 prepare 只接受 status=ready 的预览；其余返回 not_startable。Batch/Run 在后续 submit 成功事务中才创建；当前 API 无法先授权一个待集成的后继。
3. `packages/core/src/application/integration-plan-generation.ts` 的 `readApprovedBatch(projectId,batchId)` 要求真实获准 Batch，批次不存在时不能生成计划。
4. `packages/core/src/application/deterministic-integration.ts` 的 current 要求真实 Run/Batch 存在、queued/running，并且 Run/Batch 归属匹配目标后继和 Phase。当前还有 `batch.featureId === successorFeatureId` 的旧单成员条件；多成员 Batch 需要改为不可变成员范围核对。
5. `FeatureDelivery.assertTarget` 也保留单成员 Batch 归属条件。仅向组合根注入真实 Git、验证器和调度器不会改变上述准入关系。

这会阻止“前置已交付 → 授权后继集成 → 验证 → 冻结后继编码起点”的首次启动；不能靠伪造 Batch、复用其他 Feature 的 Run、直接更新 input_snapshot 或返回恒真授权来绕过。

本 Feature 输入 PRD 的 FR-05 同时要求“沿用明确获准策略和父 Batch 限制”和“不新增……隐藏 Batch”。本次执行补充约束要求 D 在 B/C 都交付且集成验证通过后才以集成 SHA 创建编码分支。它们确定了安全边界，但没有明确改变现有 execution.preview/start 的公开返回语义及 Batch 首次授权时机。

## 推荐方案 A：显式 Batch 授权先于成员编码准入

沿用用户显式调用 execution.start 所批准的固定范围和预算。预览增加“范围可授权、部分成员待依赖/集成”的明确状态；不能把未集成成员展示为编码就绪，也不能自动消除其他阻塞。

- 授权事务只冻结 project/Phase/DAG revision、成员与计划批准、仓库绑定、根基线、输入/策略/权限摘要、预算和 deadline。所有成员都在用户预览中可见；不创建隐藏 Batch。
- 根/已经就绪的成员可创建既有 queued Run；待依赖或待集成成员保留可查询的授权意图。若选择预建 queued Run，必须显式标识待基线状态，且 Task claim/Runtime/worktree 门禁均拒绝该状态。
- 只有直接前置有效交付后，集成消费者才从同一 Batch 的授权意图读取范围、当前批准和剩余预算，持久认领唯一集成身份。正常 Git 不预占模型额度；GitAgent 仍须独立已批准策略与剩余预算。
- 集成验证通过后，以同一 SQLite 短事务 CAS 绑定该成员唯一的编码基线、集成身份/revision、输入摘要及仓库绑定，再注册/唤醒后继派发。不修改前置交付、预算累计或通过标志。
- 既有 Run.input_snapshot 保持不可变。待基线成员需要新的受控一次性基线绑定记录或延后 Run 创建；不得更新既有不可变快照来补 SHA。推荐延后 Run 创建，避免把待集成输入当执行快照。
- 多成员生产消费者用不可变成员集合核对归属，移除“只能等于 Batch 锚点 Feature”的假设；保持 owner/version、控制状态和 deadline 围栏。
- Host/HostClient/CLI/查询协议需要同步新的授权状态及阻塞原因。自动补扫只消费已有明确授权，不自行扩大范围、提高并发、开启 auto_push 或调用模型。

此方案改变 execution.start 的可准入范围及预览协议，需要明确确认。确认后可继续沿现有端口实现，不需要重新 Planner 或改变 Task ID/依赖。

## 备选方案 B：保留现有 execution.start 准入

保持 execution.preview/start 只接受集成已完成的范围，另定义用户可调用的集成授权入口，明确后继/Phase、输入集合、目标基线、验证策略、父级预算归属和 CAS。该入口必须在公开审计与查询中可见；不能借其他 Feature 的 Batch 获得权限。

新授权不能凭计划批准推断模型启动授权，也不能自动清理旧 Run/工作区。它需要新的 Core/Host/CLI 命令契约与预算归属定义，不能仅在调度器中内部创建 Batch。

## 本次已完成的独立代码

`packages/core/src/adapters/integration-verification.ts` 提供真实 Node 集成检查执行器，复用现有 CommandProcess、Node collection report、输出脱敏 Artifact collector 和 Artifact publisher。它在调用方提供真实授权/进程持久确认后，执行冻结检查、核对父 deadline/Git 身份/全部前置祖先覆盖，并发布独立 plan/result 证据；缺少完整证据、停止未知、源代码漂移均拒绝通过。

构造函数不自动接入默认 Host、不创建合成 Task/Attempt、不替调用方建立授权或恢复策略。调用方还须在启动前建立持久唯一 admission，重启时先核对进程与已有证据；不能把重新调用 start 当成安全恢复。

最终局部验证：新增执行器 10 项 unit 和共享 Node 验证器 4 项 unit，共 14 项通过。最后一次定向日志为 Harness `verifications/F-014/runtime-logs/test-qmmd_edu.log`，类型检查 `test-m2x52_t4.log`，均退出码 0；前次边界检查 `test-7zm_oi2i.log` 为 603 个生产源码文件、0 条诊断。RED 和中间失败日志保留。Task 索引追加两个 unit 文件，原有集成选择与 P07 绑定保留。

本次仅验证注入 I/O 的 unit 行为。真实临时 Git/SQLite/Host/进程与故障恢复仍需本 Feature 的独立集成验收；标准生产闭环和负责人确认未通过。
