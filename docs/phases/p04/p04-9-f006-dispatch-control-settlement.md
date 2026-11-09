# P04-9 F-006：暂停/取消接入派发与槽位生命周期

日期：2026-10-22。范围：`input/p04-dispatch-foundation.md` §3.3、§3.5 标准 4–5；
`core-design/04-scheduling-and-recovery.md` §2–§4。

## 实现边界

- 新增窄端口 `ports/dispatch-settlement.ts`：Run 级派发归属 + 执行槽位的**收尾/续租**
  身份、输入校验与纯决策；新增适配器 `adapters/sqlite/dispatch-settlement.ts`。
  只读写 `run_dispatch_claims` / `execution_slot_claims`，只读 `runs`、`attempts`、
  `task_claim_receipts`、`workspace_leases`。不改写 Run/Batch/Task/Attempt 业务状态、
  预算、证据、Git 记录，不终止进程，不新增迁移。
- `adapters/work-execution.ts`：`settleRun()` 统一完成/失败/取消/暂停的结算入口；
  `heartbeat()` 对活动认领 + 槽位做有围栏续租（默认 20s，`heartbeatIntervalMs: 0`
  可关闭，测试可显式调用）；`dispatchState()` 暴露可解释的查询事实；
  `scan()` 在调度候选页之前做**有界收尾扫描**（仅 `held/quarantined` 且 Run 已终态/
  暂停/中断、无活动 Attempt 的认领，最多 64 条）。终态 Run 不在调度候选页内，必须有
  这条路径，否则取消后的占槽会永久泄漏。
- `application/work-scheduler.ts` 新增 `beforeRun` 钩子：每个候选 Run 在 DAG 评估/认领
  之前做一次受信短结算；失败被吞掉但不隐藏（原因由 Work 层记录），不阻断补扫。
- `adapters/sqlite/attempt-dispatch.ts`：已释放代次后的显式继续（resume）可以追加
  受控 `resume` 代次（`claimVersion+1`、`resumed_from_claim_id/version`），前提是上一代
  `released`、无其他活动 Attempt、无保留工作区；隔离代次仍然拒绝隐式接管。旧代次的
  迟到结算/续租按完整身份 + revision CAS 得到 `stale_dispatch_identity`，不触碰新代次。

## 安全条件（纯决策）

`decideDispatchSettlement` 的优先级：

1. 已释放 → `replayed`（幂等，不重复提升 revision）；已隔离 → 保留并呈现
   `claim_quarantined`；槽位隔离 → 认领一并隔离（槽位隔离不自动回收）。
2. 仍有 preparing/executing/verifying Attempt → 保留（暂停/取消期间当前 Task 继续
   验证与必要提交/收尾）。
3. 暂停意图未收口、或 Run/Batch 仍在执行窗口（queued/running/pausing/cancelling）→ 保留。
4. Run `interrupted` 或存在 interrupted Attempt / 已隔离工作区占用 → **隔离**
   `run_interrupted` / `stop_unverified`（停止或副作用不确定，不伪装释放）。
5. 终态 Run 仍有工作区占用 → 隔离 `workspace_uncertain_after_terminal`。
6. 暂停 Run 仍保留工作区（审批等待/后续返工复用现场）→ 保留 `workspace_retained`。
7. 槽位租约到期 → 隔离 `slot_lease_expired_unverified`（DDL 触发器要求先释放槽位）。
8. 其余（终态或已收口暂停、无活动 Attempt、无占用）→ 释放：先释放槽位，再释放认领
   （`run_dispatch_claims_release_requires_slot_released` 触发器）。

心跳只延长仍 `held` 且身份匹配的认领/槽位；到期或槽位隔离时把认领一并隔离，绝不因
续租失败而释放。所有失败只保留占槽并记录有界原因，`settlement_failed` / CAS 失败均
不产生部分写入（单事务回滚）。

## 与暂停/取消既有语义的衔接

- 暂停/取消命令仍只写意图与状态（`application/execution-pause.ts`、
  `execution-cancel.ts`）；认领事务内 `run/batch.pause_requested_at` 与 DAG
  `run_control_blocked` 已即时阻止新认领。本任务补的是「已无活动执行后如何安全归还
  派发归属与槽位」，不重做进程树终止。
- 取消：`cancel()` 在受监督收尾后结算一次；停止 operation 把 Run 收口为 `cancelled`
  后由下一次补扫（生产为 1s 有界计时器）完成释放。停止不确定时 Attempt 变为
  `interrupted`、工作区占用隔离，结算只隔离占槽。
- 暂停：无活动 Attempt 且无保留占用时释放；审批等待/验证未装配仍保留工作区时保持
  占槽（同一现场由后续显式继续复用）。显式 resume 后首次认领追加 `resume` 代次，
  Run/Task/证据身份不丢失。
- `dispatchState(projectId, runId)` 复用 F-001 `deriveRunDispatchDisplay`，并附加
  `claimState/claimReason/slotState/activeAttemptCount/retainedLeaseCount/settlement`
  供查询解释等待、隔离或释放原因，不开放原始 SQL 或队列编辑入口。

## 测试

新增 `test/modules/scheduling/p04-9-f006-dispatch-control-settlement.test.ts`（8 项）：

- 真实 SQLite（复用 F-004 的 `claimTask` 建立认领/槽位/Attempt）：
  活动 Attempt 保留；终态仍有占用 → 隔离；重复结算幂等；暂停无占用 → 释放；
  已释放后的显式继续追加 `resume` 代次；旧代次/旧 Attempt 的迟到结算与续租被
  `stale_dispatch_identity` 拒绝；停止不确定 → `stop_unverified` 隔离；验证失败回到
  running 时保留同一消费者；续租不缩短租约且校验 Attempt 版本。
- Work 组合根 + FakeRuntime：
  暂停即时阻止认领、补扫不复活、显式 resume 后仅一个 `dispatch` 代次；排队取消不启动
  Runner；取消（`await_gate` 受控运行 + 实时停止）在收口为 `cancelled` 后释放认领/槽位、
  保留取消现场（retention `reason: cancelled`/`reusable: true`）、重复结算 `replayed`。

既有暂停/取消迁移用例的旧版本上限（v32）改为按当前迁移清单派生（保留连续性与数据
断言），与 F-004 返工处理同类问题一致；未修改历史迁移或生产语义。

## 本地验证与未运行

完整 stdout/stderr 与真实退出码在 Feature workspace 的
`verifications/F-006/runtime-logs/`（`*.log` + sidecar），selection 引用仓库索引
`test/index/phases/P04/features/P04-9/tasks/F-006.json`。

| 范围 | 结果 |
| --- | --- |
| 新增 F-006 文件 | 8 passed（`test-*`，本轮最后一跑） |
| F-003/F-004/F-005 派发与槽位 | 53 passed |
| 暂停/取消/停止/结算门/入队 | 41 → 修复旧版本断言后 20 + 21 passed |
| p03-10 暂停不复活、p03-9-f008 resume | 10 passed |
| p03-4 task-claim | 36 passed |
| `npm run typecheck` | exit 0 |
| `npm run check:boundaries` | PASS，338 生产文件 0 diagnostics |

未运行：全量测试、Feature/Phase 门禁、live/真实模型、Host 纵向（本 workspace 缺
`packages/host/dist/native/writer-lock.node`）。更广回归与独立复验由 Nezha 执行；
本任务不声称 Task/Feature 通过。

## 遗留范围（显式不在此 Task）

- 重启后的接管/隔离核对（F-007）：隔离认领/槽位的最终受信释放仍由后续恢复流程提供。
- 取消/停止的进程树实现与平台验证沿用 P03-9/P04-7，不在此重做。
- Chat 会话控制、多并发派发与集成基线生成不在本 Task。
