# P04-9 F-002 Run 持久入队：启动、重试、resume 与仅收尾接线

日期：2026-10-22。范围：迁移 v34 `run_dispatch_intents`、`ports/execution-dispatch.ts`
入队契约、`application/execution-dispatch.ts` 编排、三个创建/恢复事务的接线与测试索引。
本任务不实现槽位竞争（F-003）、Task 认领衔接（F-004）与补扫循环/Work 组合根（F-005）。

## 复用了什么，以及为什么仍需一层入队结构

| 事实 | 来源 | 本任务处理 |
| --- | --- | --- |
| Run 生命周期与不可变授权快照 | `runs`（queued + `input_snapshot`/`scope_digest`/`work_key`/`dispatch_ordinal`） | 直接复用；Run 就是持久执行意图，入队不创建第二套 Batch/Run/预算 |
| 命令幂等 | `command_receipts`（commandId + requestDigest） | 不动；完整重放仍在命令服务事务内返回原回执，不进入入队路径 |
| Run 级认领/槽位 | `run_dispatch_claims`、`execution_slot_claims`（v33） | 不动；入队只登记「已授权待消费」事实，认领/槽位仍由 F-001/F-003/F-004 原语负责 |
| 派发事件 | `execution.run.dispatched`（payload 恒 `{dispatched:true}`） | 直接复用；不新增事件类型，入队与事件/Run/回执同一短写事务 |

新增 `run_dispatch_intents` 的具体原因（不能只靠 `runs.status`）：

1. `runs` 没有「第几次、以何种授权来源登记入队」的事实（首次授权/同父 Batch 重试/
   resume/仅收尾），也没有授权身份摘要；把 `source`/摘要塞进 `runs` 会与业务状态
   和历史行冲突。
2. 补扫需要一个有界、稳定顺序（`enqueued_at`）的登记序列；`created_at` 只表示
   Run 创建，resume 复用既有 Run 时不会更新。
3. `(project_id, run_id)` 唯一表达「一 Run 一意图」：重复入队复用原行，显式重试
   的新 Run 天然有独立意图；`work_key` 仍只是跨重试的逻辑工作身份，不是队列键。

表为仅插入：身份/来源/摘要/入队时间/原因列由 trigger 冻结，消费与认领不写本表
（避免预建第二套消费状态机）。旧库升级不替既有 `queued` Run 造行；这些 Run 仍按
`runs.status='queued'` 可被 F-005 的有界补扫发现，本任务不改变其授权/现场事实。

## 身份、摘要与重复入队

- 派发身份：`(projectId, featureId, runId)`；完整性由 `getExecutionRun` +
  `feature_id/batch_id` 复核。
- 授权身份摘要：`computeRunDispatchAuthorizationDigest` =
  SHA-256(`shiploop:run-dispatch-intent:v1` + stableStringify(项目/Feature/Batch/Run/
  purpose/scopeDigest/workKey/dispatchOrdinal))。这些成分在 resume 中不变（只改
  状态/revision），因此 resume 稳定复用原意图；换 scopeDigest/workKey/序号或跨项目
  Run 摘要不一致，原语在事务内重算后拒绝（`authorization_digest_mismatch`）。
- 重复入队：先查同 `(project, run)` 意图；存在且摘要相同 → `outcome='reused'`，
  不新增行、不写事件、不改回执、不动预算。摘要不同 → conflict（`intent_digest_conflict`）。
  并发同身份竞争由唯一索引兜底并回读复用。
- 显式重试：新 Run + 新 `dispatch_ordinal` → 新意图行；同 `workKey` 不合并。

## 事务内重核与拒绝面

`registerRunDispatchIntentInTransaction` 在同一 `BEGIN IMMEDIATE` 内：

1. 读取 Run（缺失 not_found、跨项目 ownership），核对 Feature/Batch 归属；
2. 以 Run 行重算授权摘要并与入参比对（过期/伪造授权拒绝）；
3. 已有同身份意图 → 复用（不再重新授权，不产生新 Run）；
4. 首次登记：项目必须 `active`、Run 必须 `queued`、Batch 必须 `queued|running`；
   终态、取消、暂停中或已开始的工作不接受新意图（暂停恢复仍需显式 resume 的
   现场核验，补扫不会自动恢复）；
5. 插入失败（含 DDL 约束/唯一竞争）不留下部分写入，由事务拥有者整组回滚。

入口只在 `CommandTransaction`（受信 Core 事务上下文）暴露，没有新增命令操作：
模型不能自由写队列。`atomic-commands` 装配面新增三个原语
（register/get/list），`CommandService` 路由与能力白名单未新增任何队列写命令。

## 四条创建/恢复路径

| 路径 | 位置 | source | 说明 |
| --- | --- | --- | --- |
| 首次明确授权 | `application/execution-start.ts` | `start` | 创建 Batch/Run/预算修订行/事件后、回执前登记 |
| 同父 Batch 显式重试 | 同上（`retryBatchId`） | `retry` | 新 Run 有独立意图；completed 回执带 `dispatchIntentId` |
| 显式 resume | `application/execution-resume.ts` | `resume` | 解除暂停后为每个被恢复 Run 登记/复用；已有意图复用原身份与来源 |
| 仅收尾重试 | `application/finalization-retry-execution.ts` | `finalization_retry` | 新 Run 与旧终态 Run 意图并存；completed 回执带 `dispatchIntentId` |

入队本身不启动 Runner、不创建 Attempt、不预扣 Attempt/Runtime 启动额度；预算
计数（`runsCreated`/`dispatchOrdinal`）仍只由既有派发原语递增一次。唤醒仍是命令
服务在**事务提交后**经 `ExecutionDispatchSignalPort` 的 best-effort 调用：事务失败
不会到达唤醒，端口抛错被吞掉且不回滚已提交事实。`resume` 的唤醒仍按既有
`resumeScope` 过滤（approval 步骤不唤醒）。

## 有界补扫读出（为 F-005 提供事实，不在此实现循环）

`listRunDispatchIntents({projectId, limit})`：`limit` 1..100（超过即拒绝），按
`enqueued_at, rowid` 返回同项目 `runs.status='queued'` 的意图，附带当前 Run 状态
与活动认领 id。暂停/取消/终态 Run 不在候选内；读取本身零写入、零唤醒、零事件，
不自动恢复任何工作。

## 验证证据（本地定向）

完整 stdout/stderr 与真实退出码在 Feature workspace 的
`verifications/F-002/runtime-logs/`（`*.log` + sidecar）。

| 检查 | 文件 | 结果 |
| --- | --- | --- |
| 入队契约 + 命令路径原子性/幂等/守卫/回滚/唤醒 | `test/modules/execution/dispatch/p04-9-f002-dispatch-enqueue.test.ts` | exit 0，10 passed |
| v34 约束、补扫上限、v33→v34 升级 | `test/modules/storage/sqlite/p04-9-dispatch-intent-schema.test.ts` | exit 0，4 passed |
| Drizzle/迁移/FK/索引对齐与迁移执行器 | `sqlite-schema-migrations.test.ts`、`sqlite-migration-runner.test.ts` | exit 0（65 + 32 passed） |
| 版本断言维护（v33→v34） | `p04-9-dispatch-slot-schema.test.ts`、`p03-6-work-session.test.ts` | exit 0 |
| 启动/重试/回执回归 | `p03-3-execution-start.test.ts`、`p03-3-work-command-receipts.test.ts` | exit 0 |
| resume 回归 | `p03-9-f008-workflow-resume.test.ts` | exit 0 |
| 仅收尾重试/收尾完成回归 | `p03-9-f010-finalization-run.test.ts`、`p03-9-f012-finalization-completion.test.ts` | exit 0 |
| TypeScript / 依赖边界 | `npm run typecheck`、`npm run check:boundaries` | exit 0（见交接记录） |
| Host 纵向收尾（仅登记，未执行） | `p03-9-f017-finalization-host-vertical.test.ts` | 本 workspace 未构建 `packages/host/dist/native/writer-lock.node`，`startHost` 报 `native_lock_unavailable`；与本任务无关，已移出索引 |

维护说明：`p03-3-work-command-receipts.test.ts` 的两处版本清单断言由硬编码
1..30 改为按 `SQLITE_MIGRATIONS` 派生（历史 checksum 冻结断言保留）；这是既有
版本漂移断言，不改变回执/幂等行为。`docs-p03-3-execution-start-contract.test.ts`
存在与本任务无关的既有失败（`APPLICATION_COMMAND_CAPABILITIES` 缺
`execution.stop.manual`），未纳入本 Task 范围且未修改。

本任务不声称 Feature/Phase 通过：更广回归、独立验证、阶段全量与 live 由
Nezha/负责人执行。
