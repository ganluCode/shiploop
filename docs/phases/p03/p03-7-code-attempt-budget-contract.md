# P03-7 / F-009 代码尝试预算结算

沿用 P03-3 的 `maxCodeAttempts`（缺省含首次共三次，合法整数 1..100）、
`maxAttemptsPerTask`（可选总 Attempt 上限），以及 v11 Task 双计数和预占账本。
不修改配置 schema、历史迁移、已有计数含义或 Task/Attempt 输入快照。

`classifyCodeAttempt` 接受受信 Core 收集的机器观察和适配器确认的逐检查失败类型。
非零退出码或输出文本不足以确认代码失败。只有 Runtime 已完成且停止确认、占用保持、
检查覆盖完整、证据完整、实际测试数为正安全整数、源码/环境/策略身份保持一致，
并且所有失败检查均由适配器确认为 `code` 时，才返回 `code_failure`。
任何认证、配置、协议、超时、环境、记录缺口、零测试或未知事实均返回
`non_code_failure`。检查顺序不影响判定；后续检查的不确定性也会阻止代码失败归类。

`settleStoredCodeAttemptInTransaction` 从 F-002 VerificationStore 读取已定版批次、
逐项 CheckResult 和证据索引，核对 Project/Run/Task/Attempt 归属，再使用该批次冻结的
代码、策略、检查及选择快照结算。调用方在事务外完成文件/进程观察，在短写事务中
组合该入口；本入口不执行外部 I/O。进行中的批次与不匹配的 Attempt 明确拒绝。
`settleCodeAttemptInTransaction` 是可组合的受信观察入口；两者均不向模型或客户端
提供自报预算分类的命令。

同一 Attempt 的多个失败 CheckResult 只结算原有一笔预占，不额外扣次。
`CommandTransaction.settleTaskAttemptBudget` 在现有账本 `reason` 中保存保留前缀
`verification-budget:v1:`、结算 outcome 和观察 SHA-256 摘要（有界 JSON）：

- 完全相同的观察重放零写入；结果顺序先规范化，人审字段不影响预算摘要。
- 相反分类或不同观察重用同一 Attempt 返回 `conflict`，不会改写已定版的预算事实。
- `non_code_failure` 单向退回已预占的代码次数；总 Attempt、Run/Batch 次数、
  Runtime 启动次数、运行时限和绝对 deadline 都不退。
- `code_failure` 与 `passed` 保留原有代码预占。已定版代码失败禁止随后被通用基础设施
  重分类入口退额；已为基础设施的重复重分类仍幂等。
- 结算标记和退额同一事务提交；失败全部回滚，SQLite 写事务串行化并发结算。

返回的 `codeRetryEligible` 只描述代码失败后的代码修复额度：默认第三次有效失败为
false，前两次为 true。调度器仍必须使用既有原子 claim/reserve 路径核对全部父预算、
Task 总上限、期限、控制状态和 fencing；这不是新 Attempt 的启动许可。耗尽沿用
`budget_exhausted` 及 layer/dimension 明确原因。本任务不创建重试、不结束 Attempt、
不更新 Task 状态；后续 F-010/F-011 在相应生命周期事务组合此结算入口。

验证覆盖：`test/modules/verification/p03-7-f009-code-attempt-budget.test.ts` 检查可信失败分类、
完整 F-002/真实 Attempt 接线、三次上限、重放、SQLite 重开、父计数不退、事务回滚、
两个真实进程的重复/冲突结算。配置默认值、整数边界、旧配置兼容和冻结输入沿用
`p03-3-budget-policy-config`、`p03-3-attempt-budget-reservation`、
`p03-3-budget-integration`、`p03-4-task-claim` 等已有回归。
