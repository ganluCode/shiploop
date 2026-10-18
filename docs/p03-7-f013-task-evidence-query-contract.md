# P03-7 F-013 Task 机器证据、人审事项与有限返工链查询契约

状态：已实现并通过任务级验证（2026-10-17）。本文档是 F-013 查询面的公共契约说明；
实现以本地代码与测试为权威。

## 1. 操作身份（冻结词汇）

| 操作 | 路由 | 说明 |
|---|---|---|
| `execution.task.verification.get` | `GET /v1/tasks/:taskId/verification?projectId=` | Task 当前机器结论 + 有界 VerificationBatch/CheckResult |
| `execution.task.approvals.list` | `GET /v1/tasks/:taskId/approvals?projectId=&limit?=&cursor?=` | 独立人审事项分页 |
| `execution.task.rework-chain.list` | `GET /v1/tasks/:taskId/rework-chain?projectId=&limit?=&cursor?=` | 有限返工链分页 + 汇总 |

- 三者与 Core `TASK_EVIDENCE_QUERY_OPERATIONS` 同源；Host `APP_OPERATIONS` 错误白名单、
  `APPLICATION_QUERY_CAPABILITIES` 握手能力宣告、`QUERY_SPECS` 查询参数白名单同步更新，
  不漂移（host-lifecycle-contract/host-app-routes 严格回归已同步）。
- Task 子资源只冻结以上三个形态；未知/多段路径一律 404 `unknown_operation`；
  `GET /v1/tasks/:taskId`（tasks.get）不受影响。taskId 只来自冻结路径参数，
  查询参数只接受 `projectId`（+ 分页参数）。
- 能力位复用 `project.read`；不新增第二个 Host、不让客户端直接读取 SQLite。

## 2. 机器证据（execution.task.verification.get）

- `task`：持久 Task 状态投影；`effectivePassed` 恒等于 `status === 'passed'`。
  **机器 passed 不展示为有效 Task passed**：机器结论只出现在 `machine.status`，
  客户端线校验强制 `effectivePassed === (status === 'passed')`（折算即
  `response_malformed`）。
- `machine`：只反映持久机器事实（批次状态 + 结算账本），不解析输出文本：
  - `status`：`none|running|passed|failed|error|inconclusive`（最新批次状态映射）；
  - `outcome`：该批次 Attempt 的最终结算（`verification-budget:v1:` 账本），未结算为 null；
  - `reason`：稳定派生代码（`no_verification_batch|batch_running|checks_passed|checks_failed|check_error|checks_inconclusive`）；
  - `codeDigest/policyDigest/codeRef/observationDigest`：代码身份与结算身份引用。
- `batches`（新→旧，上限 16，超出置 `batchesTruncated`）：批次携带
  选择/回退理由（`selection.mode/reason/selectedCheckKeys`）、代码身份
  （`codeDigest/policyDigest/environmentSummary`）与逐检查结果（argv/cwd/timeout、
  状态、退出码/信号/超时、输出 Artifact/tail 引用；未知指标保持 null）。
- 查询零写入、零事件、不触发 Runtime、不扣预算、不续租；损坏持久行 fail-closed
  `corrupt_state`，不泄漏原始内容；已定版批次是不可变证据行（迁移触发器拒绝改写）。

## 3. 人审事项（execution.task.approvals.list）

- 与机器证据分开展示：事项（kind/description）、责任主体（responsibleParty）、
  绑定摘要（planDigest/codeDigest/artifactRefs）与决定（decision/decisionActor/
  decisionReason/decisionCodeDigest/decidedAt）逐字段保留；pending 无决定、
  已决定必须同时有决定主体与时间（与持久 CHECK 同源，线校验强制）。
- 分页：`(created_at, id)` 复合键排他下界、稳定排序，`plcur_v1_` 游标绑定
  数据根 + `task-approvals` scope（跨 Task/跨项目/跨根重放一律
  `invalid_input(invalid_cursor)`）。

## 4. 有限返工链（execution.task.rework-chain.list）

- `records`：历次 Attempt（`(number, id)` 升序键集分页）与失败引用
  （errorKind/codeRef/diagnosticRef）；未知退出码/耗时保持 null（不以 0 冒充）；
  `codeAccounting` 取自 `task_attempt_reservations` 账本：分类
  （code/infrastructure）、最终结算 outcome/observationDigest、
  `countsAsCodeAttempt`（仅 code 分类折算代码额度消耗）。
- `summary`：
  - `codeEligibility`：已用/剩余代码资格只取持久计数 `code_attempts_used` 与
    策略副本 `maxCodeAttempts` 上限（缺省含首次共三次；与 submitVerification
    耗尽判定同一规则）；基础设施错误与等待人审不显示为代码额度消耗；
  - `attempts`：总 Attempt 计数；上限未配置保持 null（不虚构额度）；
  - `run`：Run 状态与暂停原因（`code_attempts_exhausted`/`approval`/
    `infrastructure_error` 等持久控制原因原样展示）；
  - `budgetBlockReasons`：与 `execution.budget.get` 同一 `buildExecutionBudgetStatus`
    纯派生的总预算阻止原因；
  - `blockedSuccessors`：后继 Task 阻断展示，与 `execution.run.schedule` 同一
    `evaluateTaskDag` 派生（Run 暂停期间顶层控制原因优先）。
- 查询不修改状态、不重开终态 Attempt、不清空累计预算。

## 5. 公共 Schema 与 HostClient

- `packages/core/src/ports/task-evidence-query.ts` 冻结公开形状；
  `packages/host/src/client/app-wire.ts` 按冻结字段集精确键校验（未知键、
  effectivePassed 折算、记账不一致、决定绑定漂移一律 `response_malformed`）。
- HostClient 新增：`getTaskVerification`、`listTaskApprovalItems`、
  `listTaskReworkChain`（复用既有 `PlanListPageInput` 分页输入与
  `plcur_v1_` 游标纪律）。
- 错误协议沿用既有映射：越权 `forbidden`、跨项目/未知目标统一 `not_found`、
  非法游标 `invalid_input(invalid_cursor)`、损坏证据 `corrupt_state`。

## 6. 测试映射

| 验收要求 | 证据入口 |
|---|---|
| 机器证据/人审查询、机器 passed ≠ 有效 Task passed、零写入 | `test/modules/verification/p03-7-f013-verification-approval-query.test.ts` |
| 返工链/失败引用/代码资格/预算与后继原因/基础设施与人审不占额度 | `test/modules/verification/p03-7-f013-rework-chain-pagination.test.ts` |
| 失败链分页、跨 Task/非法游标、越权/跨项目不泄漏 | 同上（分页用例） |
| Host 路由/白名单/公共 Schema 与应用服务一致、HostClient 纵向 | `test/modules/verification/p03-7-f013-host-query-wiring.test.ts` |
| 既有严格契约回归同步（能力清单不漂移） | `test/modules/host/host-lifecycle-contract.test.ts`、`test/modules/host/host-app-routes.test.ts` |

## 7. 边界

- 本任务只扩展只读查询；检查定义/命令/CLI 状态展示属 F-014，Feature 全量
  门禁与阶段验收在 DAG 结束后统一执行。
- 汇总派生（预算/DAG）复用既有纯函数，不落第二套可写状态；多读视图之间不
  承诺跨事务原子快照（展示面允许轻微时序差异，逐行内容仍以持久行为准）。
