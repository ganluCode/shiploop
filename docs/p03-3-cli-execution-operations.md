# P03-3 执行授权 CLI 操作说明（F-012）

- 文档状态：P03-3 / F-012 交付的 CLI 操作说明（简洁版）。上游契约：
  `docs/p03-3-execution-preview-contract.md`（预览与 previewDigest）、
  `docs/p03-3-execution-start-contract.md`（显式启动与同父 Batch 重试）、
  `docs/p03-3-execution-budget-query-contract.md`（预算状态与修订历史查询）、
  `docs/p03-3-budget-revision-contract.md`（预算显式修订 CAS）。
- CLI 只经既有 HostClient 公共面提交/查询：不打开 SQLite、不读取认证材料、
  不在本地推导授权结果；命令只经过 Host，不改全局用户配置、不调用真实模型。
- 本命令面不实现 `wait`/`cancel`/`resume`；`task prepare` 只固定输入制品组，
  **不升级为执行授权**。本文示例只使用脱敏逻辑身份（示意 UUID/占位符）。

## 1. 命令面

| CLI 子命令 | 命令身份 | Core 操作 | 语义 |
|---|---|---|---|
| `shiploop execution preview <featureId>` | `execution.preview` | `execution.preview` | 单 Feature 执行预览（只读，不是授权） |
| `shiploop execution start <featureId>` | `execution.start` | `execution.start` | 显式确认授权启动（accepted ≠ 完成） |
| `shiploop execution budget <batchId>` | `execution.budget` | 既有 `execution.budget.get`/`execution.budget.revisions` | 预算状态与修订历史（剩余额度） |
| `shiploop execution revise <batchId>` | `execution.revise` | `execution.budget.revise` | 预算显式修订（CAS + 理由） |

## 2. 参数（沿用既有模式）

- `execution preview <featureId> --project <id> --input <file> [--command-id <uuid>]`
  - `--input`：预算文档（必填；见 §3）；预览不是授权，不创建执行实体；
- `execution start <featureId> --project <id> --input <file> --preview-digest <hex64> --confirm [--command-id <uuid>]`
  - `--preview-digest`：previewDigest（用户确认的预览摘要，服务端重算比对）；过期即
    `preview_stale`，要求重新预览确认；
  - `--confirm`：明确确认（必填；缺失即输入错误，不发启动请求）；
- `execution start <featureId> --project <id> --retry-batch <batchId> --confirm [--command-id <uuid>]`
  - 同父 Batch 显式重试形态：只携带 `--retry-batch`，与 `--input`/`--preview-digest`
    互斥（同现即冲突参数拒绝）；
- `execution budget <batchId> --project <id> [--limit <int>] [--cursor <c>]`
  - 修订历史复用既有有界分页（默认 50、上限 200）；
- `execution revise <batchId> --project <id> --revision <int> --reason <text> --input <file> [--command-id <uuid>]`
  - `--revision`：目标 Batch 当前 budget_revision（唯一 CAS 入口，≥ 1）；
  - `--reason`：修订理由（必填非空，≤2000 字符；审计字段，不携带秘密）。
- 公共：`--data-root <abs>`、`--json`、写命令的 `--command-id <uuid>`（幂等/恢复）。

## 3. 预算文档（完整有限预算参数映射）

```json
{
  "batch": {
    "maxRuns": 2,
    "maxTotalAttempts": 4,
    "maxRuntimeStarts": 3,
    "maxNoProgressRuns": 2,
    "deadlineUtcMs": "2099-06-01T00:00:00.000Z",
    "maxTokenTotal": 1000,
    "maxCostTotal": 12.5
  },
  "run": { "maxAttemptsPerRun": 2, "runTimeLimitMs": 3600000 },
  "concurrency": { "maxConcurrentWorks": 1 }
}
```

- `deadlineUtcMs` 接受 epoch 毫秒整数或 ISO-8601 UTC 日期（CLI 映射为 epoch 毫秒）；
  `maxTokenTotal`/`maxCostTotal` 可选；`concurrency` 可选（缺省即单并发）；
- 预算必须**完整有限**：缺少预算字段、非法日期/整数、越界、未知键在连接 Host 之前
  以输入错误拒绝（不发启动请求）；服务端权威校验器仍完整复核；
- 有效并发大于一（`concurrency.maxConcurrentWorks > 1`）以
  `concurrency_not_supported` 拒绝：本版本只支持单 Feature 单并发执行；
- `concurrency` 只是参数把关，不进入 `budget` 请求体（并发政策由服务端权威复核）。

## 4. 结构化输出（--json 信封 result）

- `execution.preview`：`status`（ready/no_work/blocked）、`previewDigest`、`summary`
  （计划/代码/策略/检查/权限/输入身份与预算）、`authorization.confirmed=false`、
  `execution.started=false` 与 `runtimeExecution=false`；无待执行工作为 `no_work`
  （稳定 `noWorkReason`），阻塞逐条列出（`blocked`）；
- `execution.start`（accepted）：`status:"accepted"`、`executionState:"accepted"`、
  真实 `batchId`/`runId`/`operationId`、`authorization`（confirmed/previewDigest/
  retryBatchId）与 `completion.featureVerified=false`（accepted 只是提交成功，
  尚未执行、未验收，不代表 Feature 完成或业务完成）；
- `execution.budget`：`executionState` 区分四态——`accepted`（授权已受理）、
  `not_executed`（尚未执行：runtimeStarts=0、Run queued）、`budget_exhausted`
  （预算耗尽）、`business_completed`（业务完成：Task 受信通过）——并显示真实
  Batch/Run ID、各层上限与已用/剩余额度、绝对 deadline、阻塞原因与修订历史；
  未启动/未知用量保持 `null`/unknown 不填零，启动预占与实际用量分开；
- `execution.revise`：`batchId`、`budgetRevision` 与 `previous`/`revised` 前后预算
  版本对照（修订不启动执行、不清计数）。

## 5. 失败与退出码（沿用既有 0/1/2/3 约定）

| 情形 | code / details.reason | 退出码 |
|---|---|---|
| 缺少预算/非法日期/非法整数/越界/未知预算键 | `invalid_input`（`missing_budget`/`invalid_budget_date`/`invalid_integer`/`integer_out_of_range`/`unknown_input_field`） | 2 |
| 有效并发大于一 | `invalid_input`（`concurrency_not_supported`） | 2 |
| 冲突参数（`--retry-batch` 与 `--input`/`--preview-digest` 同现） | `invalid_input`（`conflicting_options`） | 2 |
| 缺失确认（start 无 `--confirm`） | `invalid_input`（`confirmation_required`） | 2 |
| 非法 previewDigest/batchId/revision/reason | `invalid_input`（解析层，不回显值） | 2 |
| 过期预览（摘要不匹配/前置漂移） | `conflict`（`preview_stale`） | 1 |
| 预算耗尽 | `conflict`（`budget_exhausted`） | 1 |
| 陈旧预算 revision | `conflict`（`budget_revision_stale`） | 1 |
| 跨项目/越权查询 | `not_found`/`forbidden`（不泄漏存在性） | 1 |
| **accepted（提交成功）** | `execution start` 受理（真实 Batch/Run 创建） | **0** |
| 连接/协议错误 | 既有连接错误码 | 3 |

- **accepted 的退出码 0 只是提交成功**：不被描述为 Feature 已验收通过/业务完成
  （业务完成只由受信结算与 `execution budget` 的 `business_completed` 显示）；
- 无待办（`no_work`）、过期预览（`preview_stale`）、耗尽（`budget_exhausted`）与
  授权拒绝均为稳定原因 + 非成功分类；错误保留 commandId 便于查回执。

## 6. 同请求恢复与幂等

- 显式 `--command-id` 重复提交先查既有回执并以原 issuedAt 重建同一冻结信封：
  同参数 → 重放原回执（`replayed:true`，同一 Batch/Run，不重复扣额）；异参 →
  `conflict`（不重新生成参数绕过幂等）；省略时由 HostClient 生成一次并冻结；
- `receipt get <commandId>` 查询固化回执：rejected 回执按 §12.3 以退出码 1 展示
  原业务拒绝（保留 commandId 与稳定原因）；
- 预算修订是唯一预算写通道（仅增额/延期）；`task prepare`/`task strategy` 不创建
  执行实体，也不升级为执行授权。

## 7. 示例（脱敏逻辑身份）

```text
$ shiploop execution preview 11111111-2222-4333-8444-555555555555 \
    --project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --input budget.json --json
→ result.status=ready / result.previewDigest=<hex64> / authorization.confirmed=false

$ shiploop execution start 11111111-2222-4333-8444-555555555555 \
    --project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --input budget.json \
    --preview-digest <hex64> --confirm --json
→ result.status=accepted / result.batchId=<uuid> / result.runId=<uuid>（未执行、未验收）

$ shiploop execution budget <batchId> --project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --json
→ result.executionState=not_executed / batch.dimensions.*.remaining / revisions[]

$ shiploop execution revise <batchId> --project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee \
    --revision 1 --reason '扩大执行预算' --input budget-revised.json --json
→ result.budgetRevision=2 / previous.version=1 / revised.version=2
```

## F-012 验证记录

- `test/p03-3-cli-execution-args.test.ts`（纯面层：命令面/参数映射/预算文档校验/
  四态结构化输出/帮助与人类行脱敏）、`test/p03-3-cli-execution-vertical.test.ts`
  （真实临时 Host + SQLite + Git：预览后确认、同命令重放、状态查询、显式修订、
  过期预览与参数错误不发启动请求、跨项目授权拒绝）与本文档守护测试；
- 纵向只经 Host 命令面：不改全局用户配置、不调用真实模型、无 wait/cancel/resume。
