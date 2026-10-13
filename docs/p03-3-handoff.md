# P03-3 集成验收与交接（F-014）

## 1. 输入与边界

输入为 `p03-execution-budget.md` v0.3（2026-10-11），本保留工作树 F-001..F-013
的实现基线为 `72b13f6a0f0df3dcec1dc99de63585f65589f42c`。F-014 仅补验收、证据和交接，
不增加产品操作、依赖或迁移。数据库接续前序 v8 至当前 v13；历史迁移 checksum 不改。
正式入口为 `packages/cli/dist/bin.js`，由真实 `npm run build` 产出。

**accepted 是持久授权提交成功，不是 Feature 验收通过。** 无 Scheduler/Runtime 装配时
Run 保持 queued、reason=`scheduler_not_assembled`，runtimeStartsReserved=0；实际
用量 token/cost 为 null，不以零冒充已知费用。准备输入、预览、修订预算均不启动 Runtime。
失败/耗尽是拒绝或停止证据，不能汇总成业务完成。

## 2. 可复现入口与证据

```text
node scripts/run-tests.ts test/p03-3-cli-built.test.ts test/docs-p03-3-handoff.test.ts
npm run verify
npm run check:boundaries
```

`test/p03-3-cli-built.test.ts` 在 beforeAll 真实构建；所有产品命令均由 dist CLI 子进程执行。
隔离 HOME/TMPDIR/数据根，环境只继承 PATH，不读取用户配置、不传递 API key、不联网或调用模型。
用真实 Git 临时项目和前序 `baseline run --confirm --wait` 发布一份需求文本制品，再走
project register/config create/phase create/feature import/feature approve/task prepare/
execution preview/start/budget/revise；业务行只由公共命令产生，不通过 SQLite 夹具插入。
基线检查是获准的 Node 文本输出进程，不是模型 Runtime，不能计入 runtimeStarts。
同 commandId 重放、CAS 旧版本拒绝以及 Host 停止重启后的查询和回执重放均复核。
时间投影单独断言 deadline 不变、参考时间前进、剩余时间减少；其他预算字段逐项不变。

Host 使用前序显式夹具 `test/helpers/host/dist-host-entry-catalog.mjs`：加载正式 dist
Host/Core，通过生产 `runHostStartEntry`/安全收尾接线，仅注入 pi/anthropic/openai
静态能力目录。**不是纯生产自动启动验收**：生产 `capabilityCatalog` 仍为空且 fail-closed，
无法凭空宣称模型策略可用。该已知 P03-1 缺口未在 F-014 放宽，不依赖不可见本机配置。
该测试也不声明真实 SDK、网络凭据或会话录制可用。

可选 `SHIPLOOP_F014_EVIDENCE=<explicit-file>` 导出 JSON：输入文档、逻辑 argv、实际
退出码/信号、stdout/stderr、Host 装配说明与退出核验。输出替换临时根/仓库/Node 路径，
复用 P02 报告脱敏器；不读取或导出 auth.token。测试失败保留 passed=false，不生成假成功。
证据目标只影响测试报告，不是 CLI 配置入口。验收时使用独立目标保留失败与成功轮次。

本次真实命令、工具版本、退出码、实现提交、日志和脱敏证据路径记入 Harness
`execution-report.md` 与 `verifications/F-014/`。完整 verify 包含全量 test、typecheck、build，
不是 affected 选择；边界检查额外执行。未执行内容明确 not_run，不能用文档守护代替行为测试。

## 3. 覆盖索引

以下文件均位于 `test/`；命令执行结果以本次报告为准，不把历史记录当成本轮通过。

| 要求 | 可追溯入口 | 证据与关键负例 |
|---|---|---|
| FR-1 正式构建主线 | `p03-3-cli-built.test.ts` | 导入/审批/prepare/预览/确认/start；同命令重放同 Batch/Run；查询/修订/重启；缺确认零回执、错误摘要、未批准 blocked、旧预算版本、跨项目查询 |
| FR-1 权威前置与原子性 | `p03-3-execution-preview.test.ts`、`p03-3-execution-start.test.ts`、`p03-3-work-command-receipts.test.ts` | no_work、计划/代码/策略/检查/权限/输入漂移、活动 Run/Batch、基线占用、多成员拒绝；Batch/Run/计数/回执/事件原子提交、提交后唤醒、不重复派发 |
| FR-2 分层有限预算 | `p03-3-execution-budget.test.ts`、`p03-3-budget-policy-config.test.ts`、`p03-3-attempt-budget-reservation.test.ts`、`p03-3-runtime-start-reservation.test.ts` | 缺字段/非法整数/跨层不一致、恰好到达上限或 deadline；Task 总数与代码次数、启动预占、幂等、失败不退还、未知用量不填零 |
| FR-2 有效进展/修订/查询 | `p03-3-run-outcome-settlement.test.ts`、`p03-3-budget-revision.test.ts`、`p03-3-execution-budget-query.test.ts` | 有效新 Task 通过才重置；日志/心跳/旧证据不算；耗尽持久停止；修订 CAS/授权/仅增额；查询一致读、剩余额度、旧 Run 不变 |
| T13 预算子集 | 上述预算、预占、结算和查询测试 | 时间/次数/未知费用与停止原因；限流告警、真实 Runtime 错误分类不属本子集，not_run |
| T21 预算子集 | `p03-3-budget-integration.test.ts`、`p03-3-execution-start.test.ts`、构建主线 | 真实跨进程争最后额度/CAS；成功 workKey 不重派发；busy/写入故障全回滚；数据库重开/Host 重启不清计数、显式增额 |
| T25 预算子集 | `p03-3-budget-integration.test.ts`、`p03-3-attempt-budget-reservation.test.ts`、`p03-3-budget-policy-config.test.ts`、前序 `p03-2-task-strategy-edit-command.test.ts` | 换模型/新 Run 不清 Task 累计次数；冻结快照不改；活动输入策略保护；完整 Attempt/Runtime 执行及前后真实会话 JSON 不在本子集，not_run |
| T31 单 Feature 子集 | `p03-3-execution-preview.test.ts`、`p03-3-execution-start.test.ts`、构建主线 | 输入变化 preview_stale、无待办 no_work、同 Phase 新 Feature 不扩范围、多 Feature 拒绝；跨 Feature 拓扑调度不在本阶段，not_run |
| 前序回归/兼容 | 完整 `npm run verify` 的 P01/P02/P03-1/P03-2 测试与 `sqlite-schema-migrations.test.ts` | 不跳过测试、不删断言；旧 accepted/分页/授权/迁移/基线退出与占用边界保持 |

## 4. 公开组合事务交接

权威端口为 `packages/core/src/ports/atomic-commands.ts` 的 `CommandTransaction` 与
`packages/core/src/ports/execution-store.ts`；SQLite 实现在 adapters，领域/application
不得直接导入数据库、HTTP 或 SDK。原语只能在同会话同步短写事务中使用，事务外与逃逸
上下文拒绝。组合事务中任一步失败必须整组回滚；文件/网络/进程等待放在事务外。

- **Run 派发**：`execution.start` 事务外预览核验，事务内重核批准复合身份、范围、
  必需输入、活动占用和预算。Batch/初始修订/Run/runsCreated/accepted/事件同事务，
  提交后才 best-effort 唤醒；持久 queued 是丢失唤醒后的权威事实。
- **Attempt**：`reserveTaskAttempt` 与真实 Attempt 创建必须同事务；同步增加
  Batch/Run attemptsCreated、Task attemptCounter/codeAttemptsUsed 和幂等账本。
  `getTaskAttemptReservation`/`getTaskExecutionCounters` 读取；同 attemptKey 重放不扣额，
  跨 Run 复用拒绝。`reclassifyTaskAttemptAsInfrastructure` 仅受信 Core 单向分类，
  只退代码次数，不退总 Attempt/启动/时间；客户端、模型不能自报基础设施失败。
- **Runtime 启动**：SDK/进程调用前以 `reserveRuntimeStart` 在获准 Run 上预占，
  `getRuntimeStartReservation` 读回。`(project,startKey)` 幂等，跨 Run 复用拒绝；
  预占后启动失败保守不退款。账本仅证明预占，不证明 SDK 启动，也不携带实际 token/cost。
- **有效进展结算**：`settleExecutionRunOutcome`/`getRunOutcomeSettlement` 将 Run 终态、
  Batch noProgressRuns 和不可变账本同事务提交；resultKey 幂等、Run revision CAS。
  仅受信持久 Task 新首次 passed 且晚于 Run 创建、未被消费的证据可重置无进展次数。
  SDK 成功退出、换模型、心跳、日志和重复通过不算。达到无进展上限持久 failed/
  budget_exhausted；既有身份可收尾，不能因此再派发新工作。
- **修订/查询**：`execution.budget.revise`（`reviseBatchBudget`）用预算版本而非行 revision
  做 CAS，独立能力授权、理由/批准主体/前后版本可审计，只增额或延期、不自动启动。
  HostClient `reviseExecutionBudget`、`getExecutionBudgetStatus`、`listBatchBudgetRevisions`
  对接 CLI execution revise/budget；读取复用 project.read，单一一致读、零写入/唤醒。
  详见 `p03-3-budget-revision-contract.md` 与 `p03-3-execution-budget-query-contract.md`。

## 5. 兼容与占用

- accepted：baseline 仍为 v5，Work accepted 为 v6（operationId=batchId，且有 batchId/runId）；
  completed/rejected 保持 v5。同父 Batch 重试派发是 completed v5，不能理解为业务完成。
  不虚造 baseline operation 承载 Work，不去掉归属外键；严格线校验器显式接受对应形态。
- `maxCodeAttempts` 缺省含首次共三次，即最多两次代码修复；旧 `maxAttemptsPerTask`
  仍是所有 Attempt 总上限，两者共同约束，不能映射成 rework_count。配置段整体覆盖，
  默认变化不追溯 Task 副本；Task 上限显式改动走 `task.strategy.update` CAS。
- baseline 的 in-flight 与隔离/停止未确认占用在启动事务中权威读取；paused/interrupted
  也不能当终态绕过。deadline 到达只产生停止理由，不能谎称进程已退出、删除占用或清计数。
  本验收生成制品的 baseline 已终态并安全释放占用，才开始执行授权。

## 6. 后序职责与 not_run

- **P03-4**：接 Scheduler/Task 选择与真实 Attempt 生命周期；同事务组合 Attempt 预占
  和创建，读取持久 queued 重建待派发，不把唤醒当唯一来源；沿用固定批准范围和 workKey。
- **P03-6**：在真实 Runtime/Runner 启动边界调用启动预占，复用稳定 startKey；把真实
  启动/退出/停止证据与预占分开；模型故障分类、SessionRecorder/用量接线不在 F-014 实现。
- **P03-9**：接完整中断/恢复与停止核对；保留累计账本、原 deadline/startedAt 与占用；
  核验进程实际停止后才释放，不重开终态 Run 或隐式创建新 Batch/增额。
- 本轮 not_run：真实付费模型、SDK/会话录制、完整暂停取消恢复、多 Feature 跑批、
  模型探测/降级、阶段 `accept:p03`。这些不作为本预算子集的通过依据，也不将本 Feature
  必需预算行为推迟给 P03-10 首次补写。生产空能力目录问题如实保留，不以测试目录冒充修复。
