# P05-9 F-006 Batch Host 协议

本增量沿用 `/v1`、线消息 v5、既有命令信封/回执与 SSE 事件 v1；新增收尾命令的 `result.schemaVersion` 为 1。能力是可协商的增量，旧客户端遇到未知能力仍按既有严格握手规则拒绝，不自动降级写入。

| 入口 | 接线与授权 |
| --- | --- |
| `GET /v1/batches/:batchId/delivery?projectId=&limit=&cursor=` | `execution.batch.delivery.get`，`project.read`；固定成员的收尾摘要，有界分页 1–200，游标绑定数据根、项目和 Batch |
| `POST /v1/commands` / `execution.batch.finalize` | `execution.start`；project scope，顶层 `expectedRevision` 为 Batch revision；payload 精确为 `phaseId/batchId` |
| `POST /v1/commands` / `phase.delivery.approve` | `feature.plan.decide`；project scope，顶层 CAS 为 Batch revision；payload 精确为 `phaseId/batchId/candidateId/expectedCandidateRevision` |

公共命令结果只含 Project/Phase/Batch/Candidate/Feature 身份、revision、范围/输入摘要、集成 commit/tree、集成/验证证据 ID 与摘要、批准 ID/摘要及冻结状态。原始候选、策略、预算/代码/计划正文、认证内容和内部路径不进入结果。响应与重放回执都重新校验版本、精确字段、状态、摘要和归属；非法敏感查询内容以 `corrupt_state` 拒绝。

HostClient 新增 `getBatchDelivery`、`observeBatch`、`finalizeBatch`、`approvePhaseDelivery`。预览、启动、暂停、恢复继续使用 `previewExecution`、`startExecution`、`pauseExecution`、`resumeExecution` 的既有结构化方法；Batch 控制目标为 `batchId`。`observeBatch` 组合有界 delivery/control 查询并核对固定成员，返回阻塞链；两个读取各有自己的快照，不声称跨请求原子性。持续观察复用 `getSnapshot`/`subscribeEvents`，关闭观察只释放连接。

## 能力与可信装配

生产 Core 组合根装配 SQLite Batch delivery 读取端口。`QueryService.batchDeliveryAvailable` 表示读取依赖实际存在，Host 据此宣告查询能力；只有一个同名方法不构成已装配证据。

收尾/批准通过 `CoreApplicationOptions.batchDeliveryFactory` / `HostStartOptions.batchDeliveryFactory` 注入可信的 `BatchLeafFinalizationService` 和 `PhaseDeliveryApprovalService`。工厂只属于静态代码装配，不接受 CLI、环境变量、配置或请求提供的服务/权限。未装配时不宣告收尾/批准命令，直接调用明确 `unsupported`。能力命令对缺一项、缺少配套查询、路由/事件 scope/版本不一致时握手失败。默认 Host 不凭候选或 Agent 自报结果获得这两个能力。

命令处理复用授权、命令摘要/回执与既有候选生命周期；同进程重复提交合并为一次执行，同 Batch 操作串行等待，每次执行前后核对 Batch CAS。候选日志决定崩溃后是否能重放，不因 HTTP 丢失重新执行不确定的 Git 操作。正在执行的收尾进入 Host 的 delivery quiesce 等待，无法确认完成时保留待处理事实。

批准存储在同一短事务中核对当前 Batch/Candidate 及摘要，保存批准记录、Phase 指针、事件和规范命令回执。命令通道传入真实请求摘要与时间，避免旧可信直接调用的简化回执与公共协议冲突。旧直接服务调用保持其历史接口；它不构成 Host 授权入口。

## 错误与事件

认证缺失为 `unauthorized`，能力/项目不可见为 `forbidden`；同一可见项目下跨项目实体与不存在实体统一 `not_found`。CAS 过期为 `conflict/stale_revision`，启动预览漂移为 `conflict/preview_stale`，重试预算耗尽为 `conflict/budget_exhausted`，人工阻塞为 `conflict/manual_block`，集成冲突为 `conflict/integration_conflict`；未知副作用要求 `reconciliation_required`。这些结果均保持拒绝/阻塞语义。

`phase.delivery.approved/invalidated` 持久事件经 Core 核对来源字段后仅公开 `{deliveryUpdated:true}`。客户端重连按原游标补读并重新查询摘要，不透传持久审计中的正文或原因。批准仍不执行 main 合并、push、Phase 关闭或新建 Batch。

## 验证范围

新增 Host 测试覆盖真实 HTTP、临时 SQLite、候选/批准存储与 SSE：查询/分页/项目隔离、畸形对端响应、能力装配/握手、权限、规范回执与重放、stale preview/预算/人工/冲突错误、重连及关闭观察、quiesce/重复提交/迟到结果与保留候选。

本地测试和工程检查的实际结果见 Harness `verifications/F-006/runtime-logs/` 与 `progress.md`。仓库索引 `test/index/phases/P05/features/P05-9/tasks/F-006.json` 还登记了受影响 HostClient/HTTP、现有 Batch wire/应用门面和收尾生命周期回归，供 Nezha 独立执行；未执行文件不计通过。

本次不修改 Git/worktree 基础操作、调度锁、派发或迁移，集成执行仍委托前置服务；不借本次 HTTP/SQLite 场景证明真实 Git 竞争恢复或模型生产能力。全仓、Phase 验收及 live 均为 `not_run`。
