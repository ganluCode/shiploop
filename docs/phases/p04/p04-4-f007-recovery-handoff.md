# P04-4 F-007 恢复组合根交接

## 交付事实

F-007 将恢复能力和来源的可信装配接到标准 Host 启动组合根：`startHost` 只接受静态 `runtimeRecoveryDescriptors` 与内部 `runtimeRecoverySources`，经过形态校验后传给 `openCoreApplication`。配置目录声明 `pi` 且没有覆盖 descriptor 时，Host 装配标准 Pi 的默认恢复 descriptor；descriptor 中的五项恢复能力仍为 `unsupported`，因此不会把 SDK Session 持久化误报为执行恢复。未注册 Pi 时不创建 Pi 恢复条目。

Core 组合根继续提供同一组端口：`runtimeRecovery` 负责来源和能力预检，`workRecoveryContinuation` 只生成同 Task 的恢复计划，`executionStart`/`workExecution` 负责实际执行入口，`queryService` 提供一致读视图。恢复来源是 `RuntimeRecoverySourceReader` 可信内部端口；客户端只能提交受约束的 Artifact 引用和身份，不能提交原生绝对路径（absolute path）、凭据或 SDK 对象。

Host 查询沿用 `execution.sessions.list` 和 `execution.session.get`。公开 Session 事实包含 runtime、adapter/native format version、执行阶段、恢复记录 watermark、gaps、结果和 control 事实；`providerSessionId`、`storage_locator`、`inputSnapshot` 正文、凭据和原生路径不进入公开投影。未知启动、耗时、退出和 usage 保持 `null`，`awaiting_verification` 与 `execution_uncertain` 保持区分。

恢复记录只作为受限审计交接事实。Recorder 必须保留 `invocationId`、requested mode、Core decision、来源身份、SDK/原生格式版本、实际 provider/model、source watermark、historical usage 的 `excluded_unknown_scope`、当前 incremental usage 范围和 gaps。恢复成功、原生 terminal 或 SDK requestId 都不能替代 Core 的 Task 验证、预算结算、锁/fencing、停止核验或人工验收。

## 下游消费契约

| 下游 Feature | 必须消费的恢复事实 | 边界 |
| --- | --- | --- |
| P04-5 Recorder | `RuntimeRecoveryRecording`、Core `sourceWatermark`、native source watermark、`coverage`、`gaps`、实际 provider/model、Session/native format version | 只记录受限审计事实；不能把 recovery frame 当作 `result`、`stopped` 或 Task 完成 |
| P04-6 usage | 当前 invocation 的去重 incremental usage、usage basis、source watermark 和 `excluded_unknown_scope` | 历史 usage 不累计；cumulative/unknown 不猜测、不加总；范围不清时保持 `null` |
| P04-7 Runtime Control | recovery mode、Core decision、拒绝/降级 reasons、Attempt/Session/invocation 身份、停止与占用诊断、recording gaps | 通过 Core control/query 服务消费；不能由 Host 或 Runtime 改写 Task 状态、预算、锁或 fencing |
| P04-8 acceptance | descriptor 版本和能力状态、测试索引、脱敏查询结果、Recorder/usage/control 证据、`not_run`/`partial` 标记 | 离线证据不能升级生产能力；真实认证、真实模型、跨 provider 与换模型实验需授权人工运行 |

## 标准 Pi、FakeRuntime 和缺失能力

标准 Pi 的生产状态见 [p04-4-f007-pi-support-matrix.md](p04-4-f007-pi-support-matrix.md)。FakeRuntime 由 `packages/core/src/adapters/testing.ts` 显式装配，脚本不来自 Host 请求、项目配置或路径；FakeRuntime 不读取 Pi Artifact、不获得 Pi `recoverySourceManager`，其协议测试不能提升生产 Pi descriptor。

没有 Pi、没有恢复 descriptor、没有来源 reader 或仅有 FakeRuntime 时，Core 保持 fail-closed：`required` 恢复拒绝，`auto` 按 Core 原因降级为新 Session，查询仍返回明确的能力/记录缺口。Core 不因恢复成功设置 Task `passed`。

## 受影响测试与证据

F-007 聚焦组合根测试为 `test/modules/runtime/p04-4-f007-composition-root.test.ts`，覆盖 Host 默认 Pi descriptor、FakeRuntime 隔离、trusted source reader 以及 Core execution/control 端口。既有恢复、查询、记录、Host lifecycle 和 Pi boundary 测试由 F-005/F-006 索引复用；本任务只运行 affected 选择，不执行未经授权的 Phase 全量或 live 门禁。

本交接使用 `verified`、`unsupported`、`unverified`、`not_run` 和 `partial` 的原始含义。Nezha 选择清单和运行日志是测试执行证据；文档本身不替代测试、Runtime result、Verifier 或人工验收。
