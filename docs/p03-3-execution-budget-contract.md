# P03-3 执行预算契约（F-001：有限分层预算校验、maxCodeAttempts 兼容规则与并发授权政策）

状态：已实现（F-001 范围：纯校验与政策路径；存储/命令/预占/结算随 F-002..F-010 落地）。
权威实现：`packages/core/src/ports/execution-budget.ts`（预算契约与纯判定）、
`packages/core/src/ports/settings-schema.ts`（配置 Schema 新政策键）、
`packages/core/src/application/task-strategy-selection.ts`（Task 策略快照捕获路径）、
`packages/core/src/application/execution-authorization-policy.ts`（执行授权并发政策）。
守护测试：`test/p03-3-execution-budget.test.ts`、`test/p03-3-budget-policy-config.test.ts`、
`test/docs-p03-3-execution-budget-contract.test.ts`。

## 1. 前序核对记录（开工核验，acceptance 1）

- 本 Feature（p03-execution-budget）线性前序为 p03-plan-approval（含 p03-1 计划导入与
  p03-2 审批/策略编辑/固定输入）。**已在当前分支实际核对**：
  - 迁移版本：`packages/core/src/adapters/sqlite/migrations.ts` 存在 v1..v8（v6 计划域、
    v7 审批、v8 `approvals.check_policy_digest`），与 p03-2 F-009 交接一致；
    P03-3 / F-002 接续：追加迁移 v9（单 Feature 执行域三表 `execution_batches`/
    `runs`/`batch_budget_revisions`，见 `docs/p03-3-execution-schema-contract.md`），
    历史 v1..v8 checksum 不变；
  - 实际代码：`feature-plan-import` / `feature-plan-decide` / `feature-plan-revise` /
    `plan-approval-verification` / `task-strategy-update` / `execution-input-prepare` 均在
    `application/` 落地，命令面经 `command-service` 接线；
  - 实际测试：`test/p03-1-plan-*.test.ts`、`test/p03-2-plan-approval-*.test.ts`、
    `test/p03-2-task-strategy-edit-command.test.ts`、`test/p03-2-execution-input-prepare.test.ts`
    等在本任务回归中全部通过（见 §8 验证记录）。
- 上游 `main` 的 `0e76ad8` 仅为 P02 基线：本工作分支
  `feat/2026-10-11-17-45-49_p03-3-feature`（基线 `feat/2026-10-11-17-45-49_p03-2-task`）
  已包含前序提交（git log：p03-1/p03-2 各 Feature 提交至 `73a0412`）。
- 结论：**前序未缺失、未发现契约冲突**，依赖能力不被阻塞；本 Feature 不重建计划导入
  或审批（未改动上述模块语义，仅新增正交政策捕获）。

## 2. 分层预算词汇（与 core-design/04 §6.1 一致）

| 层 | 上限 | 说明 |
|---|---|---|
| Batch | `maxRuns`、`maxTotalAttempts`、`maxRuntimeStarts`、`maxNoProgressRuns`、`deadlineUtcMs`（绝对 UTC epoch 毫秒） | 用户显式授权批次；必需、有限；不得用空 JSON 表示无限预算 |
| Batch（可选资源） | `maxTokenTotal`、`maxCostTotal` | 可选总额上限；用量未知时保留未知 |
| Run | `maxAttemptsPerRun`、`runTimeLimitMs` | 新 Run 重置，仍受父 Batch 累计上限 |
| Task | `maxCodeAttempts`（含首次） | 不因换 Run 清空；显式调整走 Task 策略 CAS 通道（F-009） |

预算快照（budget_snapshot）自带 `schemaVersion=1`（`BUDGET_SNAPSHOT_SCHEMA_VERSION`）：
数字但非 1 → `unsupported_schema_version`；非整数 → `invalid_schema_version`；内部上限走
同一校验（字段定位 `budgetSnapshot.batch.*` / `budgetSnapshot.run.*`），不另立第二套。

## 3. 运行时校验规则（ports/execution-budget）

- 必需预算缺失 → reason `required`；非有限（Infinity/NaN）→ `not_finite`；小数 →
  `not_integer`；非安全整数（2^53）→ `not_safe_integer`；越界 → `out_of_range`；
  类型非法 → `invalid_type`；未知键 → `unknown_key`。计数与 token 上限必须是
  **有限安全整数**；cost 上限允许小数但必须有限为正。
- 跨层一致性（`inconsistent_limits`）：
  - `maxNoProgressRuns ≤ maxRuns`（无进展 Run 是 Run 的子集）；
  - `maxTotalAttempts ≥ maxRuns`（每个获准 Run 至少预算一次尝试）；
  - `maxRuntimeStarts ≥ maxRuns`（每个获准 Run 至少预算一次启动意图）；
  - `run.maxAttemptsPerRun ≤ batch.maxTotalAttempts`（单 Run 尝试上限不得超过整批总量）。
- 绝对 deadline：提供 `referenceNowUtcMs` 时 `deadline ≤ now` → `deadline_passed`。

## 4. 数值范围（实施契约值，设计未给定，请求核对）

`maxRuns` 1..1 000；`maxTotalAttempts` 1..100 000；`maxRuntimeStarts` 1..100 000；
`maxNoProgressRuns` 1..1 000；`deadlineUtcMs` 正安全整数；`maxAttemptsPerRun` 1..100；
`runTimeLimitMs` 1 000..604 800 000（1 秒..7 天）；`maxCodeAttempts` 1..100；
`maxAttemptsPerTask` 1..100（与 settings 契约同源）；`maxTokenTotal` 正安全整数；
`maxCostTotal` 有限正数（无上限，单位由调用方约定）。

## 5. maxCodeAttempts 兼容规则（acceptance 3）

- 默认 `DEFAULT_TASK_MAX_CODE_ATTEMPTS = 3`：**含首次共三次**（首次代码执行 + 最多
  两次代码修复）；是新策略定义，不套用旧 rework_count。
- 现有 `maxAttemptsPerTask` 保持**总 Attempt 上限**语义（约束全部 Attempt，含基础设施
  类尝试），不被重解释为代码尝试上限。
- 两者同时生效按 `min` 解析（`resolveTaskAttemptCaps`）：代码尝试是总 Attempt 的子集；
  `rule` 显式标记绑定方（`code_cap_only` / `total_cap_binds` / `code_cap_binds` /
  `equal` / `code_cap_default(_bounded_by_total)`）。
- 判定（`evaluateTaskCodeAttemptReservation`）：`used ≥ cap` 即拒绝（恰好到达即耗尽）。

## 6. 配置、合并与 Task 快照路径（不另建配置体系）

- 配置 Schema：`policies.executionLimits.maxCodeAttempts`（可选，1..100，与
  `maxAttemptsPerTask` 同段同校验）。**schemaVersion 维持 2**：本字段为段内可选新增键，
  旧 v2 payload（无该键）继续有效且语义不变；旧版本 Core 读到含该键的 payload 因未知
  键 fail-closed 拒绝；未知/未来 schemaVersion（1、3+）仍一律拒绝（校验面
  `payload.schemaVersion`，持久读取面 `corrupt`）。
- 合并：沿用 `mergeEffectiveSettings` 段级整体覆盖（项目段含新字段即整段替换全局段；
  项目段不含时**不得**从全局段内继承该字段；均未配置时无该字段）。
- Task 策略快照：`selectTaskStrategy` 在创建时从当前有效配置捕获
  `executionConfig.maxCodeAttempts`（配置了才捕获；未配置不注入字段，使用时按缺省 3
  解析）。快照不可变：读取或修改默认配置（含全局/项目 settings.update）不追溯改写
  既有 Task 的 `execution_config`（真实 SQLite 验证：更新全局配置后既有 Task 副本逐字节
  不变，新导入 Task 捕获新值）。旧快照（无该字段）继续通过
  `validateTaskExecutionConfig`；显式调整复用 `task.strategy.update` 整体替换 CAS 通道。
- `userOverride` 路径同样从有效配置捕获政策（政策解析与策略来源正交）；该路径现在同样
  校验提供的来源 scope（无效来源不再被忽略——fail-closed 收紧，不影响合法输入）。

## 7. 执行授权并发政策（acceptance 4）

- 配置面允许保存 `maxConcurrentWorks ∈ [1,16]`（settings 契约不变）——**保存政策不等于
  执行支持**。
- 执行授权面（`assertSingleWorkConcurrencyAuthorization`）：有效并发（项目段 > 全局段 >
  缺省 1）**大于一即明确拒绝**，reason `concurrency_not_supported`，不静默降级串行、
  不悄悄放行。P03-3 后续 prepare/start（F-004/F-005）接线时复用本规则。

## 8. 纯预算判定语义（acceptance 5）

- 临界值：计数 `used == limit` 恰好耗尽（拒绝新预占）、`used == limit-1` 恰余一次；
  deadline `now == deadlineUtcMs` 恰好到达即耗尽（`deadline_reached`）。
- 未知 token/cost 用量（null/缺省）：维度 `used/remaining/exhausted = null` 并列入
  `unconfirmedDimensions`，**不用零费用证明仍有额度**；未配置资源上限不产生该维度
  （不虚构 0 限额）。已知用量按上限比较（`resource_exhausted`），cost 小数正常比较。
- 非法用量/时间（负数、非有限、非安全整数、now 早于 startedAt）一律拒绝，不钳制、
  不默认 0。
- 分层纯函数不读时钟：所有当前时间由调用方显式传入。
- 边界（check:boundaries 强制）：domain/application/ports 不导入 HTTP、ORM（Drizzle/
  better-sqlite3）或 Pi SDK；本 Feature 新模块均为纯函数。

## 9. 范围边界（本 Feature 不实现）

SQLite 迁移与 budget_snapshot 存储（F-002）、accepted 回执扩展（F-003）、prepare 预览
（F-004）、ExecutionController 启动（F-005）、预占/分类记账（F-006/F-007）、结算与
无进展（F-008）、修订 CAS（F-009）、查询（F-010）、Host/CLI 接线（F-011/F-012）、
跨进程竞争（F-013）与集成验收（F-014）。

## 10. 验证记录（F-001）

- 新增：`test/p03-3-execution-budget.test.ts`（91 用例：校验矩阵/一致性/快照版本/解析
  兼容/临界值/deadline 恰好到达/未知资源用量）、`test/p03-3-budget-policy-config.test.ts`
  （25 用例：旧配置/显式新政策/非法字段/版本不兼容/合并/快照捕获与不追溯（真实
  SQLite）/并发授权拒绝）、`test/docs-p03-3-execution-budget-contract.test.ts`（本文档守护）。
- 受影响回归：settings-schema-v2、effective-settings-merge、p03-1-task-strategy-selection、
  p03-1-plan-import-command、p03-1-plan-revise-command、p03-2-task-strategy-edit-command、
  p03-2-context-build、p03-2-execution-input(-prepare)、p03-2-host-wiring、
  configuration-service、settings-query-service 全部通过。
- 完整门禁（scope=full）：`npm run verify`（test + typecheck + build）与
  `npm run check:boundaries` 结果见 progress.md 与提交记录。
