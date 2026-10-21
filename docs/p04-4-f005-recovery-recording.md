# P04-4 F-005：恢复记录与新增事件边界

## 交付范围

`RuntimeRecoveryRecording` 是受限的审计交接事实，不是恢复授权或执行成功证明。它包含来源 Attempt/Session、不可变 `nativeArchiveRef` 与摘要、原生格式和 SDK 版本、请求模式与实际决策、实际 provider/model、新 provider session、旧 Core 水位、原生档案条目边界及缺口摘要。历史消息正文、SDK 对象、文件路径和凭据不进入交接结构。

Pi Adapter → Runner 的 `recovery` 帧 → Host Adapter → Core RuntimeSession → Recorder 保留同一份交接。Runner 在当前事件流之前发送事实；接收端拒绝重复、过迟、来源/模式不匹配及越界字段。交接有界等待，缺失或失败不阻断当前记录，而是保留 Core 已知来源并声明 unknown。Core 句柄单独校验该 Promise，交接到达不意味着 events/result/stopped 已完成。

## 水位与 usage

- `sourceWatermark` 只从 Core 的来源 Work Session 读取；Adapter 提供的旧 Core 水位不能覆盖它。旧 Session 缺失、旧水位为空或旧 gaps 不明均显式记录缺口。
- `nativeSourceWatermark` 是已验证的不可变 JSONL 档案条目数和最后条目 ID，仅用于追溯原生来源，不能替代统一审计水位。
- 新日志序列从 1 开始，scope 固定为 `current_invocation`。沿用 Recorder 的当前 invocation 身份校验、序列协调和重复事件丢弃。只记录当前请求和当前事件，不复制旧日志。
- Pi 的最终 `agent_end` 快照仅接受当前事件流中已经匹配的稳定消息 ID；不匹配的历史快照被排除并报告 `pi.recovery.snapshot_scope_unknown`。缺少稳定 SDK 消息 ID 时保留当前部分输出并报告 `pi.recovery.event_identity_unknown`。
- `historicalUsage` 固定为 `excluded_unknown_scope`，旧 `historicalBaseline` 仍为 null。累计、unknown 或恢复时没有明确 incremental 范围的 reported usage 不累加；父子统计或最终快照的范围不明时同样不猜差值。原始 usage 观察和 `finalReported` 保留供后续诊断。
- 仅已去重的本次 incremental usage 可以累加。恢复后未观察到 usage 时 totals 为 null、complete=false；失败清单也遵守这一语义。
- 恢复 coverage 仅为 partial/unknown；它与当前事件日志的 coverage 含义不同，不能声称完整原生历史已被 Recorder 接管。

## Session 与终态

异步 Runner 在 Session started 后才能观察原生身份，因此 activity 允许首次补齐 provider session/native format。SQLite 在相同 owner/host/executionVersion/revision 下校验，只接受 started Session，并拒绝替换既有绑定。ended 可补齐结果首次返回的 provider session，也拒绝替换已知身份；stopped 仍拒绝原生绑定写入。

结算合并并去重 Recorder 已存 gaps、恢复缺口以及 recording_required/stop_unconfirmed，不覆盖旧缺口；超过 32 项时保留 overflow 标记。新水位只指向已持久化的当前日志。取消、事件流失败、模型配置拒绝和停止未确认都保留已知来源及诊断；历史成功快照和原生状态不能把新 Attempt 标为完成。结算制品也应用已知凭据脱敏。

## 本地证据

完整 stdout/stderr 与真实退出码 sidecar 均在当前 Feature workspace 的 `verifications/F-005/runtime-logs/`。以下为最终有效的定向结果，不是全文件回归或 Feature 验收结论。

| 文件/范围 | 通过 | 日志 | 退出码 |
| --- | ---: | --- | ---: |
| recovery/p04-4-recovery-recording，全部新增用例 | 6 | test-v1fobwj0.log | 0 |
| p04-4-pi-managed-session：recovery-recording-boundary、recovery-missing-message-id、approved-source、auto-safe-downgrade、actual-route-mismatch、unknown-writer-stop | 6，跳过 33 | test-vz9r_ev7.log | 0 |
| p04-1-pi-runner：runner-recovery-handoff、runner-recovery-invalid | 2，跳过 5 | test-w6qpaoox.log | 0 |
| p03-6-runtime-session：recovery-handoff-independent | 1，跳过 14 | test-cqzy2_6g.log | 0 |
| p03-6-work-session：recovery-native-binding | 1，跳过 20 | test-smkicx7o.log | 0 |
| p03-6-runtime-settlement：recovery-terminal-gaps、recovery-start-rejected | 2，跳过 25 | test-g93r_kq2.log | 0 |
| TypeScript --noEmit | — | test-7jg4ts73.log | 0 |
| 架构边界，315 个生产源文件、0 diagnostics | — | test-4x5j53yw.log | 0 |

六个测试文件的定向范围共 18 个不同用例通过。先前有效 GREEN 结果在相关行为没有改变时保留，没有为改变输出过滤重复执行。末次 TypeScript 检查覆盖所有最终实现和测试类型修正。

RED 与中间诊断原样保留：test-czfo68x5.log（Recorder 交接缺实现）、test-orelj91f.log（Runner 协议缺实现）、test-62zg_32g.log（终态丢失旧 gaps）、test-82giy4jf.log（activity 拒绝异步原生绑定）、test-d4scavzg.log（ended 拒绝结果 provider session）。其他 fixture/类型错误及对应修正日志也保留，不将它们算作产品验收失败或成功证据。

## 独立验证交接

仓库索引 `test/index/phases/P04/features/P04-4/tasks/F-005.json` 按 Nezha v2 登记 18 个受影响文件；Harness `test-selection.json` 只引用该索引。六个本地触及文件也登记完整范围，供独立验证；其余 12 个文件本轮仅选择，未在 Runtime 执行。范围涵盖既有 Recorder、Session 查询、恢复记录、恢复访问/原生边界、Runner/Adapter/停止/装配、Runtime 契约及 Attempt 生命周期。

较广 affected 回归与最终 task/feature 结论由 Nezha 独立执行。没有运行全仓测试、组合 verify、Phase 验收或真实模型调用。F-006/F-007 的完整恢复装配/纵向验证以及 P04-5/P04-6 的完整 Recorder/usage 查询仍按原任务边界交接。
