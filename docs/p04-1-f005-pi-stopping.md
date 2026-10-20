# P04-1 F-005：Pi Runner 取消与停止证据

F-005 在 F-002/F-004 的 Runner 与事件通道上增量实现取消、有限执行时限和异常退出。Core 的预算、授权、lease、进程监督、重试与结算仍由原有服务负责。

## 执行与控制

- SDK adapter 缓存第一次取消的 Promise。abort 最多调用一次，等待 1 秒后按真实观察返回 accepted、sdk_abort_failed 或 sdk_abort_timeout；重复请求不会把拒绝改成接受。正常完成后的取消返回 already_settled。
- Runtime timeoutMs 到期请求同一条 abort 路径，终态为 timed_out。取消后最多等待 2 秒形成终态；仍挂起的 prompt/idle 保留停止未知。收尾清除观察定时器，flush 最后部分消息与 usage，关闭事件流，unsubscribe/dispose 各一次，忽略迟到事件。
- standalone Runner 将 SIGTERM/SIGINT 转换为 AbortSignal，调用已启动句柄的 cancel。进程组发信号、升级终止和 OS 身份验证仍复用 CommandProcess；没有自行发 kill、重新启动或创建锁。
- 私有协议新增 cancel_receipt，沿用原 invocation/project/run/task/attempt/session/executionVersion 及连续序号校验。回执与事件/结果通过同一有序写入队列输出。进程停止请求被接受与 SDK 取消回执分别保存。
- Runner 的 stopped Promise 拒绝或超时转成 runner_runtime_stop_unknown；Host 对通道排空、进程停止及资源 verifier 的观察均有限。通道断开、崩溃、信号终止、执行超时、停止未知和核验超时分别保留结构化诊断及已知退出码/信号。

## 停止确认的装配边界

SDK idle/dispose 仅产出 confirmed=false 的本地观察，detail 为 pi_sdk_idle 或 pi_sdk_stop_unknown。Host inspect 分别暴露 SDK cancelReceipt、processCancelAccepted、eventsEnded、terminalResult、processExited 和 resourceStop；这些观察不会互相替代。

可信装配可以向 createPiRunnerAdapter 注入既有 WorkResourceStopVerifier 和 snapshot(request)。只有受控进程组停止、Runner 已退出、流已排空、SDK idle，以及独立资源 token 全部满足时才 confirmed=true。snapshot 和 token 必须精确绑定 project、attempt、invocation、owner、hostInstanceId、executionVersion 以及包括 OS startTime 的完整 CommandProcessIdentity。token inspect 必须与送验快照一致。

verifier 必须检查独立的工具/资源范围，不能通过等待本 RunnerHandle.stopped 构成循环。未注入 verifier、工具核验失败或超时均保留 false。后续可信业务装配应按已有资源端口提供该证明；本任务没有新增生产资源注册或业务装配。现有 Core supervision 在 false 时隔离并保留占用，阻止自动重跑。

真实子进程测试使用无工具的 Fake Pi session，由现有 CommandProcess.recoverStop 核验该受控组，并由测试 WorkResourceStopVerifier 签发绑定快照的 opaque token。它证明真实信号/SDK abort/进程组链路，不代表已经验证真实 provider、凭据或生产工具实现。

为保留 SDK 用量，补齐 Core usage 事件外层字段白名单中的 completeness/accounting：内层 validateRuntimeUsageReport 已支持这两个字段，真实 Runner 用例发现外层提前拒绝并导致崩溃。缺失值仍保持 null/unknown。

## 本地验证和交接

任务范围测试：三个 Pi 文件 49 passed、0 failed、0 skipped，包含新增 31 项停止测试、真实受监督子进程和真实 Core SQLite/Git 占用隔离用例。最终日志为 Feature workspace 的 verifications/F-005/runtime-logs/test-7axqxts6.log，exit 0。

- 类型检查：test-escx3giw.log，exit 0。顺带修正已修改 Pi 测试中的类型导入、嵌套 attempt identity 和 usage payload 收窄，根 typecheck 通过。
- 包边界检查：test-kfqwk97q.log，exit 0，291 个生产源文件、0 diagnostics。
- 初始 SDK 幂等回执 RED：test-nwqkd0cu.log；初始错误停止确认 RED：test-zcylis_i.log；真实 Runner 用量字段拒绝 RED：test-6y9f6mxb.log。中间失败、夹具修正与完整退出码 sidecar 均保留。

仓库索引：test/index/phases/P04/features/P04-1/tasks/F-005.json。Harness test-selection.json 仅引用该索引。前三文件已本地执行；其余五个 Core 契约/监督/不确定性回归仅登记，由 Nezha 独立执行。本轮没有运行全仓测试、组合 verify 或阶段验收，没有真实模型调用。任务报告仅声明本地完成，最终验收由 Nezha 决定。
