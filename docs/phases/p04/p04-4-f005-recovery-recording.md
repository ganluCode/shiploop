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

## 初次提交的本地证据

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

## attempt 2 独立验收返工

从 `4eb61ca` 与干净工作区续做，保留首次实现和已提交成果。本次 invocation 为 `ac864a2e5344447195b5a4bbb57c56d1`；首次 completed claim 不代表独立验收通过。独立验收 `3e26718779e5460abf8525068725093b` 的失败暴露了回执消费端漏接 `launch`、迁移测试漏列 v31，以及本地 Host 原生锁产物缺失。

认领输入、持久回执重放和输入绑定现在复用严格的 `validateTaskClaimLaunch`。允许冻结的 Session/invocation/parent 身份，仍拒绝未知键、空 ID 和错误类型；输入绑定拒绝与请求不同的冻结 Session/invocation；重放逐项核对原请求的 launch，损坏回执不能改写身份。新测试验证数据库重开后的幂等重放、同 key 换身份的冲突、损坏持久事实的拒绝和无额外写入。测试仅在一次性夹具中、先证明不可变触发器有效后移除该触发器以注入损坏；生产约束保持启用。

两份迁移测试补列 v31，继续验证已有历史不变、失败回滚、重试幂等和外键完整性。使用既有 `node scripts/build-host-lock.ts` 生成本地原生锁后，原先失败的 Host 与 Pi 场景已实际通过；原生产构建/原生锁源码未改动。

Pi 装配断言保持 F-005 的保守语义：SDK result=completed 但 usage 范围未知时，原始观察保留、totals=null、coverage=partial，required 记录不能据此把 Attempt 送入验证。增加 `host-pi-no-usage` 对照，证明完整消息流且未报告 usage 时仍可正常进入 verifying；取消继续保留 `recording_failed:aborted`。未通过忽略 usage、删除诊断或放宽 required 记录来消除失败。

| 本次实际执行范围 | 通过 | 日志 | 退出码 |
| --- | ---: | --- | ---: |
| claim 重放、输入绑定、两份 populated v15/v16 升级 | 4，跳过 72 | test-6c36o__w.log | 0 |
| Host Fake 执行、断连/取消重放、鉴权、writer lock | 4，跳过 2 | test-gc8drgel.log | 0 |
| Host cancellation/result race | 1，跳过 5 | test-5ad35qkk.log | 0 |
| Pi host-pi-complete/no-usage/cancel、sdk-absent-core-fake | 4，跳过 15 | test-j0og2vp5.log | 0 |
| TypeScript --noEmit | — | test-gr8het49.log | 0 |
| 架构边界，315 个生产源文件、0 diagnostics | — | test-fb9l8nw0.log | 0 |

本次五个文件共 13 个不同用例通过，均有当前 invocation 的 completed sidecar 和真实退出码。TDD RED `test-oqoj2g23.log`（launch 接收缺失）与 `test-zhd1u3hn.log`（冻结身份不一致未拒绝）保留，夹具修正、中间诊断及中断日志也保留；未取得完整退出码的运行不计入本表。首次提交的 18 项证据作为既有记录保留，不声称本次重跑。

## attempt 3：补齐旧恢复授权夹具

attempt 2 后的独立验收 `0d726d8076d940b18406188d8d399750` 为 20 文件中 19 通过、399 用例中 398 通过；唯一失败是输入绑定的 required 恢复正例，原因是旧夹具的当前状态和来源证据均未保存 `workAccess`，触发 `work_access_missing`。

本次从 `5f358a7` 增量修改测试夹具：在真实不可变恢复证据 Artifact 与当前可信 reader 中提供相同的合成 Fake 访问快照，包含策略、ready 认证摘要/引用和空资源清单。reader 按端口返回 unknown，真实恢复服务继续校验；不把 Fake 状态冒充 Pi 专用访问类型。生产代码和全部原有断言保持原样，包括恢复后停止状态变成 unknown 时拒绝授权。

本次 invocation `82fe917191734daf98ec68723e276af6` 的最终证据：

| 实际执行范围 | 结果 | 完整日志 | 退出码 |
| --- | --- | --- | ---: |
| 输入绑定完整文件 + work access 恢复复核完整文件 | 47 passed，0 failed，0 skipped | test-g_pft89i.log | 0 |
| TypeScript --noEmit | 通过 | test-z1aiuivf.log | 0 |

RED `test-oblrziny.log` 精确复现同一缺口。中间 `test-p7o4y429.log` 的 47 项通过及 `test-6tc8b5y1.log` 的 Fake/Pi 类型冲突诊断均保留；调整测试 reader 类型后重跑上述最终检查，重复运行不重复计数。完整输出、invocation 和退出码 sidecar 位于原 runtime-logs 目录。

重新核对原 20 文件 v2 索引及 Harness 引用，两个实际执行文件均已登记，保留全部 affected 范围。本次仅执行上表两文件和类型检查，完整 20 文件回归继续交 Nezha 独立验收；旧的独立验收结果不作为本次通过证明。

## 独立验证交接

仓库索引 `test/index/phases/P04/features/P04-4/tasks/F-005.json` 按 Nezha v2 登记 20 个受影响文件；Harness `test-selection.json` 继续引用同一索引。attempt 2 新增 claim 和输入绑定两份完整文件选择，原有 18 份均保留。attempt 2 实际执行上述五文件定向范围，attempt 3 实际执行上述两文件完整范围和类型检查；最终代码的 20 文件完整 affected 回归仍交独立验证。

较广 affected 回归与最终 task/feature 结论由 Nezha 独立执行。没有运行全仓测试、组合 verify、Phase 验收或真实模型调用。F-006/F-007 的完整恢复装配/纵向验证以及 P04-5/P04-6 的完整 Recorder/usage 查询仍按原任务边界交接。
