# P04-8 / F-006 离线控制矩阵：取消、超时、强杀、停止不确定与证据完整性

日期：2026-10-22。对应 `p04-acceptance.md` FR-1、FR-2 与验收标准 1。库实现
`test/helpers/p04-8/control-fault-matrix.ts`，测试入口
`test/modules/execution/control/p04-8-control-fault-matrix.test.ts`（18 用例，
macOS 专用，`describe.skipIf(process.platform !== 'darwin')`）。

## 组成与场景

只使用真实临时 SQLite/Git（`openClaimFixture` / `openBindingFixture` /
`openProcessRecoveryFixture`）、共享三代受控写入进程（P04-7
`process-matrix-writer.mjs` + `processRows` 清点，不复制夹具）和生产公开接口
（`createCommandProcessAdapter`、`execution.cancel` 命令、`createRuntimeSettlementService`、
`createWorkEvidenceRecorder`、`runP04StepSequence`、P04-8 隔离夹具）。不调用
模型或网络，不递归启动全量或阶段入口。

### 矩阵一：控制事件（验收标准 1）

| 场景 | 控制回执 | 进程树 | Attempt/Run 终态 | 停止证据 |
| --- | --- | --- | --- | --- |
| request-cancel | 真实 `execution.cancel`：先 `cancelling`（占用仍在），真实停止确认后二次提交 `cancelled` | 取消意图期间成员 ≥3 仍在写；确认停止后清点 0 | run `cancelled`/`user_cancel`、1 个 Attempt、`run_not_active` 阻止认领 | result `cancelled` + stop operation `stopped` |
| tool-cancel | `handle.cancel()` accepted；固执写入者忽略 SIGTERM 后升级 SIGKILL | 成员 ≥3 → 0，SIGKILL 在升级路径 | 1 Attempt、taskPassed=false、无新 Attempt、租约清零 | `stop.confirmed` + 恢复 `reconciled` |
| execution-timeout | 短 `timeoutMs` → `timed_out` | 整组 SIGKILL 后清点 0 | 同上 | `stop.confirmed` + 恢复 `reconciled` |
| host-exception | fork 测试 Host 被 SIGKILL；受控树不受 Host 死亡影响 | Host 死后成员 ≥3 仍写；新 Host 侧恢复升级停止后 0 | 恢复 `complete`、taskPassed=false、租约清零 | 恢复证据 `reconciled` |
| runner-kill | 整个受控进程组被 SIGKILL；监督者无法上报 → `supervisor_lost`，不伪造成功 | 清点 0 | 恢复 `complete`、无新 Attempt | 缺席核验 `confirmed` + 恢复 `reconciled` |

### 矩阵二：停止不确定（验收标准 2）

- `cancel-stop-uncertain`：interrupted 且占用隔离时取消只返回 `stop_uncertain`；
  3 条 quarantined 租约与 run 行保持，认领被 `run_control_blocked` 阻止，
  迟到 run 级成功结算抛错；cleanup 不得标记为通过。
- `recovery-stop-unconfirmed`：监督者被单独 SIGKILL 后孤儿后代仍在写文件，
  恢复返回 `blocked`/`workspace_reconciliation_required`，`stop_unconfirmed`
  缺口与人工处置步骤保留；3 条租约与 managed_workspace 保持 quarantined，
  认领 t-2 抛错。测试自有物理 SIGKILL 清点 0 后，业务隔离结论仍保留
  （物理停止 ≠ 业务恢复）。

### 矩阵三：迟到结果（验收标准 3）

- `late-model-result-after-cancel`：run 取消终态后迟到成功结算抛错；
  run/attempts/预算计数不变、check_results 为 0、Task 不 passed。
- `late-settlement-after-cancelled-attempt`：已取消终态 Attempt 的两次重复
  fulfilled 结算均 `ignored`（fence），业务表、预算计数、Git HEAD 不变。
- `late-tool-and-process-results-after-cancel`：真实受控进程正常退出 0 后，
  取消窗口（run `cancelling`）内迟到工具事件只进可见记录（水位前进）；
  携带取消控制事实的迟到“成功”结算使 Attempt 落为 `cancelled` 而非
  verifying/succeeded，run 控制状态不被覆盖，预算不变、不制造通过。

补充事实：Attempt 已 `cancelled` 终态后记录器直接拒绝迟到记录
（`checkWorkSessionFence` 要求 preparing/executing），并写入
attempt_notification_diagnostics 审计行——本矩阵将记录窗口放在取消窗口内，
以覆盖“记录可见、业务不被覆盖”的路径。

### 矩阵四：报告与证据完整性（验收标准 4）

- `report-dir-corrupt`：篡改 `state.json` 水位哈希后 resume 抛
  `P04StepError(evidence_corrupt)`；篡改字节与既有步骤证据逐字节保留。
- `evidence-missing`：删除步骤证据后 resume 同样 fail-closed，且 0 个步骤被执行。
- `nonempty-dir-reuse`：非空证据目录拒绝 fresh 复用（`evidence_dir_not_empty`），
  旧内容原样保留、无步骤执行。
- `cleanup-failure`：越权目录清理抛错（`cleanup_not_authorized`），
  cleanupEvidence 为 `unknown` 而非 passed，目标目录现场保留。

## 证据与清理

`runControlFaultMatrix(options)` 依序执行四组矩阵并在可选 `evidenceDir` 写入
`control-fault-matrix-{events,stop-uncertainty,late-results,report-integrity}.json`
与 `control-fault-matrix-summary.json`（含各组场景数、停止确认数、清理确认数；
`live: not_run`），供 F-007 集成报告聚合。每个场景在 finally 中执行自有停止与
清点；清点非零时保留目录（现场），清点为零才删除。

本地验证：18/18 通过（exit 0），日志
`verifications/F-006/runtime-logs/test-5njgl1xx.log`；运行后无遗留受控进程、
无残留临时目录。旧用例与更广回归交 Nezha 独立复验（见任务索引 F-006.json）。
本矩阵不宣称阶段通过；真实 Pi live 与人工验收另行发起。
