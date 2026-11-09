# P04-6 F-003 效率事实与耗时投影交接

## 接口与边界

Core 公共入口导出 `projectEfficiency({ facts, observations?, coverage?, truncated? })`。
它只消费公共事件或 Artifact 已采集的事实，不读时钟、文件、数据库或 SDK 原生档案。
F-004 可在已有报告一致读视图内准备输入并复用该纯函数；本 Task 未接线 Host/CLI 查询。

`EfficiencyFact` 兼容旧结构，追加可选 `budgetMs`、`unknownReason`。
输出保留调用身份、来源、预算、状态、退出码和信号，缺失预算归一为 null，并给出未知原因。
`modelRequestTimingBasis=waiting_network_generation` 表示请求区间包含等待、网络和生成，不能当作纯推理时间。
失败/取消的模型请求归入 `failed_model_request`；退避保留独立阶段，不重复计入成功请求。
调用按 Attempt/Session/Invocation 与 requestId、toolCallId 或 testRunId 合并；
Git、收尾和单次退避使用稳定 factId。重试必须提供不同实际请求身份，不能用一次逻辑请求身份覆盖多次执行。
没有调用身份时保留各事实并标记 partial，不猜测跨事实关联。

## 时间与后台测试

- `cumulativeMs`：已知完整区间的累计值，保留并发调用成本。
- `activeWallClockMs`：所有已知区间的并集，跨阶段/overlapGroupId 的重叠也只计一次。
- `wallClockSpanMs`：完整范围最早开始至最晚结束，含中间空隙；边界或范围不完整时为 null。
- 缺失边界/截断只提供已知小计并标记 unknown/partial，不用当前时钟补终点。
- started 的 `lifecycleStatus` 为 running，但 `processLiveness` 始终为 unknown；持久历史不证明进程仍活着。
  启动回执的 duration/exitCode 不作执行结果：duration 保留为 `reportedDurationMs`，实际 duration/exitCode 为 null。
- 分离的开始/终态可以合并，迟到 started 不覆盖终态；不同终态、开始时间或模型归属冲突时结果未知。
  合并后逆序的时间边界不会产生负时长。来源引用在合并后保留。

## 效率指标

`EfficiencyObservation` 分 reply/tool/context，所有条目必须关联既有来源。
有效回复、批量调用、Codemode、重复读取、工具错误、大输出都来自显式布尔采样；
没有采样不填 0，不按工具名、正文猜测或净增删行反推。
父工具调用与叶操作分列，工具/回复关联限定于相同 Core Invocation；提供平均 `toolsPerReply` 和 `replyTools` 明细。
缺少稳定消息/请求身份时不声称已完整采集。
上下文首/峰/末来自明确的单次请求 inputTokens；不是累计用量，也不证明 SDK 上下文窗口大小。
截断或缺采样时首/末为 null，已知峰值只标 partial；原始采样仍可追溯。
每次投影最多 10,000 条时间事实和 10,000 条指标采样，超过上限明确拒绝，由调用者负责有界取数。
`coverage` 入参/输出描述输入声明范围；各 timing/metric/context 对象分别给出自身完整度。

## 本地验证

以下日志位于 Harness Feature workspace 的 `verifications/F-003/runtime-logs/`，
均由 `nezha.dag.test_command` 保存完整 stdout/stderr、实际耗时和退出码旁文件。

- 最小 RED：`test-zj37fpox.log`，退出 1，缺少 `projectEfficiency` 实现。
- 首次 GREEN：`test-8qd7maz8.log`，退出 0，1 项通过。
- 生命周期/指标扩展 RED：`test-lb0ve74r.log`，退出 1，4 个预期缺功能失败。
- 最终定向验证：`test-wov_r275.log`，退出 0，2 文件 14 项通过。
  本地执行 `p04-6-efficiency-projection.test.ts` 与 `p04-6-usage-diagnostics-contract.test.ts`。
  IPC 屏障控制真实短 Node 子进程退出 7，人工时钟以实际退出事件作为终态，证明启动耗时 2ms 不冒充执行耗时 1500ms；没有 sleep 或网络/模型访问。
- 类型检查：`test-p5qclzpx.log`，退出 1，唯一错误为未修改的既有
  `test/modules/runtime/p04-6-usage-normalization.test.ts:22` TS2345：
  `"new" | "replay" | "resume" | "unknown"` 传给只接受 `"new" | "resume" | undefined` 的测试 helper。
  本 Task 新增/修改文件没有编译诊断；未改动 F-002 文件来消除该基线错误。

较广回归只登记在 `test/index/phases/P04/features/P04-6/tasks/F-003.json`，
用量归一化、旧 Recorder、旧进程停止三个文件交 Nezha 独立执行，未宣称本地通过。
Harness selection 只引用该仓库索引；未执行全量测试、组合门禁或阶段验收。
本地定向通过不是 Feature 验收结论，正式任务状态由 Nezha 独立验证维护。
