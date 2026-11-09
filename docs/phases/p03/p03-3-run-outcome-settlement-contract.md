# P03-3 / F-008 Run 结果结算与连续无进展契约

实现：`ports/execution-store.ts`、`adapters/sqlite/execution-store.ts`、迁移 v13
及 Drizzle `schema.ts`。设计依据：core-design/04 §6.1 的有限分层预算、
不退还启动消耗、绝对 deadline、有效领域进展与成功 workKey 不重派发。

## 1. 受信 Core 内部入口

`CommandTransaction.settleExecutionRunOutcome` 和 `getRunOutcomeSettlement`
只能在同会话同步短写事务内使用。逃逸事务上下文不可复用，事务外调用拒绝。
不经命令路由暴露，不新增客户端/模型命令、APP capability、公开 state event
或回执版本。此入口不代替后续 Verifier，也不实现 Runner 或完整暂停/取消/恢复流程。

结算输入仅接受：

```ts
{
  projectId: string;
  batchId: string;
  runId: string;
  resultKey: string;
  runRevision: number;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  reason: string | null;
  progressEvidence?: { type: 'new_valid_task_passed'; taskId: string } | null;
}
```

`resultKey` 是受信 Core 生成的稳定身份，非空白且至多 128 字符；revision 是
至少 1 的安全整数；reason 是 null 或至多 512 字符的非空白字符串。未知字段
及未知证据类型返回 `validation`。运行成功文本、SDK 正常结束、心跳、日志、
换模型不是领域进展，即使 `outcome=succeeded` 也不能据此重置计数。
没有证据或省略证据等价于 `progressEvidence=null`。

## 2. 证据来源与新事实

唯一有效类型为 `new_valid_task_passed`。Task 的 passed 状态必须来自受信 Core
领域写入；测试通过明确命名的 `trustedFixtureMarkTaskPassed` 提供，不运行模型、
不修改生产库、不把 SDK 结束解释为验证通过。本入口核验持久状态，不执行检查。

迁移 v13 追加 `tasks.first_passed_at`：受信 Task 首次转换到 passed 时，触发器
记录该领域写入的 `updated_at`；插入已 passed 的 Task 同样记录首次通过。
旧库已 passed 的 Task 以升级前 updated_at 回填。非空标记不可改写，标签、模型、
策略元数据更新及重复状态写入不产生新通过事实。同一 Task 只认首次有效通过，
重新验证/计划修订后的新证据版本属于后续 Verifier 的扩展，不在本任务内。

同事务核验 Task 存在、同项目、同 Batch Feature、当前 status=passed；否则
`not_found`、`ownership` 或 `conflict progress_evidence_not_verified`，零结算写入。
首次通过必须严格晚于 Run.created_at、不晚于结算时钟，且未被同项目任何结果账本消费。
已有事实、同毫秒无法确定先后的事实及旧证据重放保守记为 `none`，不重置计数。
证据只能引用 Task ID，不能由调用方提交 passed 时间、真假布尔值或模型成功宣称。

## 3. 幂等、CAS 与原子性

1. 输入及 Batch/Run 归属核验先于写入，缺失为 `not_found`，范围不符为 `ownership`。
2. `(project_id,result_key)` 去重先于 CAS 和控制状态：同 Batch/Run 结果重放返回
   原账本，即使传入旧 revision 或其他 outcome，也不修改原结果；跨 Run 复用
   返回 `conflict result_key_reused`。
3. 新结果身份必须匹配当前 Run revision，否则 `conflict run_revision_stale`。
   终态 Run 返回 `conflict run_already_settled`；不能以新 resultKey 再结算或倒写终态。
4. 同一 BEGIN IMMEDIATE 内完成 Run 终态/ended_at/revision、Batch 连续无进展
   计数/revision 与不可变账本插入，任一异常由事务边界全部回滚。

账本 `run_outcome_settlements` 保存结果身份、终态、有效证据、结束时间及
`no_progress_runs_after`。DDL 约束同项目 Batch/Run/Task 外键，resultKey 唯一，
Run 唯一，生效 Task 证据部分唯一；账本 UPDATE/DELETE 均拒绝。
`runs.ended_at` 首次赋值后不可改写，既有 started_at 与 Run 输入快照仍由 v9 保护。
历史 v1..v12 SQL/checksum 不变，v13 仅追加。

## 4. 有限预算和停止原因

有新有效领域进展才将 `no_progress_runs` 重置为 0，否则结束 Run 恰好加一次。
达到当前批准预算快照的 `maxNoProgressRuns`，活动 Batch 终态化为 failed 并持久化
`reason=budget_exhausted`。已终态 Batch 仍记录结束 Run 的计数，但不倒写其状态/原因。
`runs_created`、`attempts_created`、`runtime_starts` 和 Task 双计数均不退款。

真实 `execution.start` 同 Batch 重试先检查 Batch 状态，因此已耗尽 Batch 返回
`batch_not_active`；持久化 reason 仍为 budget_exhausted。活动 Batch 的预算判定
另有 maxNoProgressRuns 防御性检查。未到上限的失败重试只增加 runs_created，
不清无进展计数、不重新初始化预算。已成功 workKey 返回 `work_key_succeeded`，
不因新的重试命令或数据库重开而重新派发。

结算允许已有身份在 deadline 后收尾，不因此创建新的 Run/Attempt/Runtime 启动。
新启动在 `now >= deadlineUtcMs` 拒绝，Run 尝试按原 started_at 计算时间上限。
绝对 deadline、预算 revision/快照、范围/配置/输入快照与 Run 时间依据在暂停、
后续 Run 和数据库重开中保持不变；暂停不自动延期，重开不从进程变量清零。
不实现 token/cost 用量结算，不把未知用量当零。

## 5. 验证入口

- `test/modules/execution/budget/p03-3-run-outcome-settlement.test.ts`：真实临时 SQLite、注入时钟、可信领域
  夹具；幂等/CAS、三终态不退款、进展及旧事实/元数据重放、上限、归属、回滚、
  事务上下文、v12 数据升级保留、重开逐字段一致、deadline/Run 时间恰好到达。
- `test/modules/execution/budget/p03-3-execution-start.test.ts`：经受信事务结算后的真实命令重试，连续无进展
  累计、耗尽后停止、成功 workKey 拒绝再派发，保持既有命令协议。
- `test/modules/storage/sqlite/sqlite-schema-migrations.test.ts`：Drizzle 与真实 DDL 列、CHECK、索引及外键一致。
- `test/modules/execution/budget/docs-p03-3-run-outcome-settlement-contract.test.ts`：契约和受信命令边界守护。

受影响测试选择记录于 Harness `verifications/F-008/test-selection.json`；
工程门禁仍为 `npm run verify` 与 `npm run check:boundaries`。
