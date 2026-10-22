# P04-9 F-005 有界持久补扫与 Work 组合根

日期：2026-10-22。范围：`WorkScheduler` 的持久分页扫描、finalization-only 准入、
`assembleWorkExecution` 接线与同 Run 串行派发测试。不新增队列表、不新增迁移，
不改变预算/Attempt/Slot 原有权威，也不开放 P05 多并发。

## 复用了什么，为什么不再造调度器

| 事实 | 来源 | 本任务处理 |
| --- | --- | --- |
| Run 业务状态、授权快照、`dispatchOrdinal`/`workKey` | `runs`（P03-3 v9） | 直接复用；只按状态选候选，不改写 Run |
| 已授权待消费事实与登记顺序 | `run_dispatch_intents`（F-002 v34，仅插入） | 作为补扫的 rank 0 来源，`enqueued_at, rowid` 顺序 |
| 查询/command 幂等与提交后唤醒 | `command_receipts` + `ExecutionDispatchSignalPort` | 不动；唤醒仍只是 best-effort，SQLite 是权威 |
| Task 认领、Attempt、预算、占用 | `claimTask`/`beginLaunch`（P03-4、F-004） | 调度器只在 DAG 就绪后用现有入口，不新建记账 |
| Run 级认领与单槽 | `run_dispatch_claims`/`execution_slot_claims`（F-003/F-004） | 同 Run 后续 Task 复用同一代认领与槽位，由认领事务判定 |
| finalization-only 分流 | `isFinalizationOnlyRun` + `finalization`/`finalizationCompletion` 端口（P03-9） | 保留；补槽位/资源准入前置核对 |

## 有界补扫与稳定游标

`SchedulerStore.listActiveRuns` 改为对两个持久事实做 keyset 分页：

| rank | 来源 | 排序键（不可变） | 作用 |
| --- | --- | --- | --- |
| 0 | `run_dispatch_intents JOIN runs`，Run 仍 `queued` | `enqueued_at, rowid` | 丢失唤醒/Host 重启后无需旧内存信号即可发现未派发 Run |
| 1 | `runs`，`running/pausing/paused/cancelling/interrupted`，以及无意图的 legacy `queued` | `created_at, rowid` | 同 Run 下一 Task 串行续跑与旧库候选 |

- 游标 `SchedulerScanCursor = {projectId, runId, rank, key1, key2}`，下一页从最后一行
  的不可变键继续；`nextCursor` 为空时不重复读同一页，`hasMore` 与游标同时成立才继续。
- 页大小/页数/唤醒集合分别有上限（默认 32/4/256，显式校验）；`wake` 只降低延迟，
  集合满后丢弃唤醒仍由计时器补扫兜底，重复唤醒被合并。
- 扫描中同一 Run 只消费一次（状态推进可能让两个来源短暂重叠），不产生第二次认领。
- 已登记意图但已离开 `queued` 的 Run 仍必须从 rank 1 被发现，否则同一 Run 的后续
  Task 会在首个 Task 结束后“消失”。这是本任务修复的关键回归（由组合根测试覆盖）。

## 消费链路

1. `readRun` → finalization-only 分流（不评估编码 DAG、不认领）。
2. 普通 Run：`evaluateTaskDag` 只取 `readyTaskIds[0]`，不预先把所有 Task 入队。
3. `prepareClaim`（工作区/输入/预算准备）→ `claimTask` 自有提交事务（F-004 原子
   衔接 Run 归属/槽位与 Task 认领）。
4. 只有拿到已提交回执后才 `consumeClaim`；无槽消费者在 `claimTask` 阶段失败，
   Runner 不会被调用。
5. 同 Run 后续 Task 复用同一 owner/host 的 held 认领与同一槽位；Runtime 结束只把
   Attempt 推进到 verifying，Task/Run 通过与否仍由验证收尾决定。

## finalization-only 准入

`WorkSchedulerOptions.admission` 是无副作用前置核对：返回非空原因即只写
`runs.reason` 并等待后续补扫，不调用 finalization、不创建编码 Attempt、不启动
Runtime。生产装配读取既有持久占用事实：

- 同项目存在 `held/quarantined` 且未到期的 `execution_slot_claims` →
  `execution_slot_unavailable`；
- 同项目存在 `global:execution` 的 `workspace_leases`（项目 Work 门控）→
  `project_execution_gate_busy`。

`all_passed` handoff 与 `finalizationCompletion` 的既有幂等语义不变；缺消费者时
仍持久化 `feature_finalization_consumer` / `feature_final_verification_consumer`
阻塞原因。未装配 Runtime 时 `signalRunDispatched` 记录 `runtime_not_found`。

## 启动/关闭生命周期

- Core 启动恢复门控未解除前：`workExecution.scan()` 返回空页，
  `signalRunDispatched` 直接返回，`scheduler.start()` 不启动计时器。
- 门控解除后 Host 调用 `work.start()`；此后由提交后唤醒 + 有界计时器共同补扫。
- `close()` 先停止新认领（quiescing），清理计时器与待处理唤醒，等待在途扫描结算；
  关闭后 `scan` 只返回 `closed`，不再认领。
- 扫描不打开写事务等待 Runtime/Git：`claimTask` 事务在调用 `consumeClaim` 之前已提交，
  工作区准备与 Runtime 启动都在数据库短事务之外。

## 验证证据（本地定向）

完整 stdout/stderr 与真实退出码在 Feature workspace 的
`verifications/F-005/runtime-logs/`（`*.log` + sidecar）。

| 检查 | 文件 | 结果 |
| --- | --- | --- |
| 派发意图/续跑分页、稳定游标、重建调度器补扫、双唤醒不重复认领 | `test/modules/scheduling/p04-9-f005-persistent-dispatch.test.ts` | exit 0，6 passed |
| finalization-only 缺消费者、准入忙/空闲、handoff 幂等 | 同上 | exit 0 |
| 组合根两依赖 Task 复用同一认领/槽位、Runtime completed 不等于 passed、收尾不建 Attempt | 同上 | exit 0 |
| 启动门控解除前不消费、解除后补扫、关闭后不再认领 | 同上 | exit 0 |
| 既有有界扫描/补偿游标/关闭清理 | `p03-4-scheduler.test.ts` | exit 0 |
| 暂停不自动复活 | `p03-10-verification-pause.test.ts` | exit 0 |
| finalization 分流与 handoff | `p03-9-f011-finalization-execution.test.ts` | exit 0 |
| 三 Task 串行链（正式装配 + FakeRuntime） | `p03-7-f016-e2e-three-task-chain.test.ts` | exit 0，1 passed |
| 组合根扫描与推理预检 | `p04-3-pi-inference-preflight.test.ts` | exit 0，12 passed |
| TypeScript / 依赖边界 | `npm run typecheck`、`npm run check:boundaries` | exit 0（336 文件 0 diagnostics） |

环境限制：本 workspace 未构建 `packages/host/dist/native/writer-lock.node`，
`startHost` 返回 `native_lock_unavailable`；`p03-4-schedule-host-wiring`、
`p03-9-f005-startup-recovery`、`p03-9-f017-finalization-host-vertical`、
`p04-5-recording-integration` 等 Host 纵向因此无法本地执行（与本 Task 无关，
且未纳入索引）。启动门控语义已由上面的 Core 组合根用例覆盖。

本任务不声称 Feature/Phase 通过：更广回归、独立验证、阶段全量与 live 由
Nezha/负责人执行。
