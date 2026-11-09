# P03-9 / F-015 Run/Batch 控制、retryFinal 与恢复诊断 CLI 接线

日期：2026-10-19。状态：CLI 纯面层参数/视图/帮助与 app-execute 纵向接线已交付；
不新增 Host 操作、不改变冻结线消息版本（仍 v5）。Core 授权与事务语义仍为唯一权威。

## 1. 目标与边界

把 F-014 已接入 HostClient 的控制/恢复能力暴露为应用命令 CLI 入口：

- 命令：`execution pause`、`execution resume`、`execution retry-final` 与
  `execution cancel` 的 Run/Batch 目标形态（`--run`/`--batch` + `--revision` +
  `--confirm`），分别映射 Host 操作 `execution.pause`、`execution.resume`、
  `execution.retryFinal`、`execution.cancel`；
- 查询：`execution control <runId>`、`execution batch-control <batchId>`、
  `execution recovery <runId>`，映射 `execution.run.control.get`、
  `execution.batch.control.get`、`execution.run.recovery.get`（只读零副作用）。

CLI 只经 HostClient 公共面：不打开 SQLite、不读取业务文件、不直接操作进程、
不把 attempt cancel 与 Run/Batch cancel 混为同一请求。既有
`execution cancel <attemptId>`（`execution.attempt.cancel`）保持不变。

## 2. 参数纪律（提交前本地拒绝，退出码 2）

- 控制目标 `--run`/`--batch` 恰一：同现 `conflicting_options`、双缺
  `missing_control_target`；`--revision` 必填且 ≥1（`invalid_revision`）；
- Run/Batch cancel 必须显式 `--confirm`（`confirmation_required`）；positional
  attemptId 形态与 `--run`/`--batch`/`--revision` 互斥；
- `retry-final`：positional featureId、`--historical-run`（UUID v4）、
  `--work-key`（非空 ≤256，`invalid_work_key`）；
- 不提供恢复模式注入参数：`--recovery-mode`/`--resume-mode`/`--session-mode`
  一律未知参数拒绝；auto/new/required 由 Task 策略/输入快照决定（F-014 契约
  同一约束），CLI 只经恢复诊断展示；
- 解析在任何 I/O 之前完成；`--command-id`（UUID v4）显式冻结命令身份。

## 3. 结构化输出与退出码

- pause/cancel/resume completed 回执投影为
  `ExecutionControlCommandView`：`outcome`/`status`/`revision`/`changed` +
  stop operation 引用 + 显式 `note`/`nextStep`。pausing/cancelling 明确为
  「尚未暂停/尚未停止」；`stop_uncertain` 输出「停止不确定，先核对
  evidenceRef 证据」；`already_terminal` 零写入语义显式。任何输出不宣称
  已暂停/已停止/验收通过；
- resume 回执（`resumed: true` + `runtimeStarts: 0`）注明「工作流 resume ≠
  Runtime/SDK 原生续接；恢复模式由任务策略/输入快照决定」；
- retry-final 视图携带 `historicalRunId`/`newRunId`/`missingSteps`/
  `revalidateTaskIds`/`finalCheckKeys`/`finalizationScopeDigest` 与
  `runtimeStarts=0`（仅收尾重试，零 Runtime 启动、不重复编码）；
- control/batch-control/recovery 视图：冻结 `nextActions` 附带可理解说明；
  停止 operation 的 `stopConfirmed`/`forced` 未知保持 null（人类行 unknown）；
  恢复续接记录展示 `requested.mode`（auto/new/required）与 `decided.mode`
  （resume/new），请求续接但实际新建会话即 **Fake 新 Session 降级**，显式
  标注与原因；预算用量 null 恒显示 unknown；
- 退出码沿用既有约定：0 成功（completed）、1 业务拒绝（stale_revision、
  conflict、idempotency 冲突等）、2 输入错误、4 观察中断。

## 4. 幂等与 follow 断开语义

- 显式 `--command-id` 先查回执并以原 `issuedAt` 重建同一信封：同参数命中
  服务端摘要重放返回原回执（`replayed: true`），不同参数 `conflict`；
- events 观察退出（snapshot-only 正常退出或 follow 被 Abort，退出码 4）只
  结束本次观察：不发送 stop/cancel、不改变后台执行，Host 状态经独立查询可见。

## 5. 聚焦验证

- `test/modules/cli/control/p03-9-f015-cli-control.test.ts`（18 项，纯面层）：参数映射、提交前
  拒绝矩阵、四种场景（工作流 resume / Fake 新 Session 降级 / 停止不确定 /
  仅收尾重试）的结构化输出与帮助边界；
- `test/modules/cli/control/p03-9-f015-cli-control-vertical.test.ts`（4 项，真实 Host + SQLite +
  Git + FakeRuntime 测试装配，零模型）：pause/control/幂等重放/Run 级 cancel/
  follow Abort 不取消/retry-final 创建受限新 Run（runtimeStarts=0、旧 Run
  保持终态）/recovery 查询展示零用量与 finalization scope；
- 受影响回归：p03-3/4/6/7 CLI 面与 host/commands 契约共 370 项已运行通过；
  其余列入 `verifications/F-015/test-selection.json` 由 Nezha 独立复验。
