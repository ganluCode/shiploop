# P03-2 计划决策 / Task 策略编辑 / 固定输入 CLI 操作说明（F-008）

- 文档状态：P03-2 / F-008 交付的 CLI 操作说明（简洁版）。上游契约：
  `docs/p03-2-plan-approval-contract.md`（决策语义）、
  `docs/p03-2-task-strategy-edit-contract.md`（策略副本 CAS 编辑）、
  `docs/p03-2-execution-input-prepare-contract.md`（固定输入制品组）。
- CLI 只经 HostClient 公共面读写：不打开 SQLite、不读取认证材料、不在本地
  推导批准成功或替换 modelMap；执行能力（Run/Work/模型）本版本不提供，
  未知执行能力不显示为可运行。
- 本文示例只使用脱敏逻辑身份与引用（示意 UUID/占位符），不含真实路径或凭据。

## 1. 命令面

| CLI 子命令 | 命令身份 | Core 操作 | 语义 |
|---|---|---|---|
| `shiploop feature approve <featureId>` | `feature.approve` | `feature.plan.decide` | 批准当前计划摘要（不启动执行） |
| `shiploop feature reject <featureId>` | `feature.reject` | `feature.plan.decide` | 拒绝当前计划摘要（不删除计划） |
| `shiploop task strategy <taskId>` | `task.strategy` | `task.strategy.update` | 完整策略副本 CAS 编辑（来源服务端定值 `task_edit`） |
| `shiploop task prepare <taskId>` | `task.prepare` | `execution.input.prepare` | 固定输入制品组准备（不创建执行实体） |
| `shiploop task inputs <commandId>` | `task.inputs` | 既有 `receipts.get` | 查看已准备的固定输入（不新增查询面） |

## 2. 参数（沿用既有模式）

- `feature approve|reject <featureId> --project <id> --digest <hex64> --revision <int> [--reason <text>] [--command-id <uuid>]`
  - `--digest`：提交时绑定的当前计划摘要（64 位小写 hex；审批绑定身份，不是 CAS 依据）；
  - `--revision`：目标 Feature 聚合 expectedRevision（唯一 CAS 入口，≥ 1）；
  - `--reason`：可选决策原因（≤2000 字符；不携带秘密）；
- `task strategy <taskId> --project <id> --revision <int> --input <file> [--command-id <uuid>]`
  - `--input`：完整 executionConfig JSON（schemaVersion=2 标记；runtime/provider/model
    必需，可选 credentialRef/endpointRef 引用）；整体替换，不从既有副本/默认配置拼补；
  - `--revision`：目标 Task 自身 revision（唯一 CAS 入口）；
- `task prepare <taskId> --project <id> --feature <id> --input <file> [--command-id <uuid>]`
  - `--input`：`{"items":[{"purpose":...,"source":{"kind":"artifact","artifactId":...} |
    {"kind":"file","root":...,"relativePath":...}}]}`（必填；缺失必需输入必须显式声明，
    空清单由服务端明确拒绝）；
- `task inputs <commandId>`：`task prepare` 命令的命令 ID（UUID v4，位置参数）。
- 公共：`--data-root <abs>`、`--json`、写命令的 `--command-id <uuid>`（幂等/恢复）。

## 3. 结构化输出（--json 信封 result）

- `feature.approve|reject`：实际计划身份（`feature.planDigest`、`approval.subjectDigest`）、
  当前审批状态（`feature.planStatus`、`approval.status`/`current`/`reason`）与执行边界
  视图 `execution`（`started:false`、`capability:"unknown"`、`runnable:false`）——
  批准与拒绝输出均明确未启动执行，未知执行能力不显示为可运行；
- `task.strategy`：`task`（id/featureId/revision/status）与 `strategy`
  （完整 `executionConfig` 副本 + `configSource`/`configSourceKey` 来源）；
- `task.prepare`/`task.inputs`：输入制品组 `group`（snapshot/manifest/prompt 各正文的
  `purpose`/`version`/`contentHash`/`sizeBytes`/`locator`/`mediaType`）、`requiredInputs`
  （`purpose`/`version`/`contentHash`/来源逻辑身份）、`digests`（三正文摘要 +
  策略副本/权限面内容身份）、`approval`（planDigest/checkPolicyDigest/decisionId）与
  `execution` 执行边界视图；正文永不内联。

## 4. 失败与退出码（沿用既有 0/1/2/3 约定）

| 情形 | code / details.reason | 退出码 |
|---|---|---|
| 缺 `--digest`/`--revision`/`--input`、非法摘要、未知参数 | `invalid_input`（解析层，不回显值） | 2 |
| 策略/清单的秘密或身份字段（apiKey/token/password、principalId 等） | `invalid_input`（`input_secret_field_rejected`/`input_identity_field_rejected`，不回显值） | 2 |
| 非法策略（缺必需字段/孤立 model/未知键/非法引用） | `invalid_input`（服务端权威，`payload.executionConfig.*`） | 2 |
| 空必需输入清单 | `invalid_input`（`empty_items`，不静默省略） | 2 |
| 摘要不匹配 / 重复决定 / 陈旧 revision | `conflict`（`plan_digest_mismatch`/`approval_already_decided`/`conflict`） | 1 |
| 跨项目/越权 | `forbidden`（不泄漏存在性） | 1 |
| 缺必需输入（未知/未就绪制品等） | `not_found` | 1 |
| `task inputs` 指向非 `execution.input.prepare` 回执 | `invalid_input`（`receipt_operation_mismatch`） | 2 |
| 连接/协议错误 | 既有连接错误码 | 3 |

错误与帮助信息不泄漏秘密、不回显参数值、不含开发机路径。

## 5. 同请求恢复与幂等

- 显式 `--command-id` 重复提交先查既有回执并以原 issuedAt 重建同一冻结信封：
  同参数 → 重放原回执（`replayed:true`）；异参 → `conflict`（不重新生成参数
  绕过幂等）；省略时由 HostClient 生成一次并冻结；
- Task 覆盖走同一 `task.strategy.update` 策略 CAS 命令（无第二条写入通道）；
  批准不会顺便重新应用默认策略，也不覆盖 Task 策略副本；
- `task inputs` 沿用既有回执/结果读取查询制品组身份，不新增查询面、不读正文。

## 6. 示例（脱敏逻辑身份）

```text
$ shiploop feature approve 11111111-2222-4333-8444-555555555555 \
    --project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee \
    --digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --revision 1 --json
→ result.feature.planDigest / approval.status=approved / execution.started=false

$ shiploop task strategy 22222222-3333-4444-8555-666666666666 \
    --project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee \
    --revision 1 --input strategy.json --json
→ result.strategy.configSource=task_edit（完整副本整体替换）

$ shiploop task prepare 22222222-3333-4444-8555-666666666666 \
    --project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee \
    --feature 11111111-2222-4333-8444-555555555555 \
    --input items.json --json
→ result.group[]: purpose/version/contentHash（正文永不内联）

$ shiploop task inputs <prepare 命令 ID> --json
→ 同一制品组身份（version/hash/用途）经回执查询读取复验
```

## F-009 集成回归登记

- `test/modules/planning/p03-2-integration-regression.test.ts` 以正式构建 `dist/bin.js` + dist Host
  复核本文档操作主线：三 Task 导入 → `task get` 查看策略副本 → 批准前可选覆盖
 （`task strategy`，来源 task_edit）→ `feature approve --digest` 指定摘要批准 →
  `task prepare`/`task inputs` 固定输入准备与读取复验 → `host stop`（三证据 +
  pid 退出）→ 重开后查询/回执/制品正文逐字节一致；失败退出按本文档约定
 （参数/结构失败 2、业务拒绝 1，具体原因在 `details.reason`）。
- 结构化输出的执行边界视图（`started:false, capability:"unknown", runnable:false`）
  在主线与重开复验中均保持「未启动执行、未知执行能力不显示为可运行」。
