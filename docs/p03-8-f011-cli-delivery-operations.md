# P03-8 Feature 交付 CLI 操作说明（F-011）

- 文档状态：P03-8 / F-011 交付的 CLI 操作说明（简洁版）。上游契约：
  `docs/p03-8-f008-delivery-commands.md`（授权命令通道与可信装配）、
  `docs/p03-8-f009-git-operation-queries.md`（Git 操作查询面）、
  `docs/p03-8-f010-feature-delivery-query.md`（Feature 分轴结果查询面）。
- CLI 只经既有 HostClient 公共面提交/查询：不打开 SQLite、不直接执行 Git、
  不读写代码工作目录、不读取认证材料；命令只经过 Host。响应丢失先查既有
  回执再以同一冻结信封重试（不更换 commandId 造成重复副作用）。
- 本命令面不实现 push/PR/自动合并、不实现 P03-9 的新 Run 收尾重试控制；
  待核对的 Git 操作按既有核对命令（git.operation.reconcile）处理。
  本文示例只使用脱敏逻辑身份（示意 UUID/占位符）。

## 1. 命令面

| CLI 子命令 | 命令身份 | Core 操作 | 语义 |
|---|---|---|---|
| `shiploop feature delivery <featureId> --project <id>` | `feature.delivery` | `features.delivery.get` | Task/最终检查/审批/交付分轴结果（只读） |
| `shiploop git operations --project <id> (--feature <id> \| --run <id>)` | `git.operations` | `git.operations.list` | Git 意图/实际提交/回执分页（只读） |
| `shiploop git operation <operationId> --project <id>` | `git.operation` | `git.operations.get` | 单条 Git 操作详情与回执投影 |
| `shiploop feature final-approve <featureId> ... --confirm` | `feature.final-approve` | `task.approval.approve` | Feature 最终审批（既有授权命令） |
| `shiploop feature finalize <featureId> ... --confirm` | `feature.finalize` | `feature.verification.continue` | 显式收尾请求（既有授权命令） |

## 2. 参数（沿用既有模板）

- `feature delivery <featureId> --project <id>`：只读查询；featureId 为稳定
  ID，非法形态在连接 Host 之前退出 2；
- `git operations --project <id> (--feature <id> | --run <id>) [--limit <int>] [--cursor <c>]`：
  父级二选一（缺失 `missing_required_option` 或同现 `conflicting_options`
  均本地拒绝，退出码 2）；分页与游标同计划列表
  （`plcur_v1_` 不透明键集游标；跨数据根/跨项目/跨父级/畸形一律
  `invalid_cursor`）；
- `git operation <operationId> --project <id>`：operationId 为 UUID v4，
  非法形态本地拒绝（`invalid_operation_id`，退出码 2）；
- `feature final-approve <featureId> --project <id> --task <id> --item <id> --digest <hex64> --code-digest <hex64> --revision <int> [--reason <text>] [--artifact <ref> ...] --confirm [--command-id <uuid>]`：
  - 决定绑定当前摘要：`--digest` 当前计划摘要 + `--code-digest` 当前代码
    摘要（均为 64 位小写 hex，必填）；摘要漂移由服务端 fail-closed 拒绝；
  - `--revision` 是事项 expectedRevision（唯一 CAS 入口）；
  - `--confirm` 必填：缺确认在任何 I/O 之前本地拒绝
    （`confirmation_required`，退出码 2），不推进收尾；
  - 客户端伪造主体（actor/principalId/decisionActor）、明文凭据或 Git 身份
    参数在解析层即未知参数（`unknown_argument`，退出码 2）；
- `feature finalize <featureId> --project <id> --run <id> --batch <id> --operation <uuid> --revision <int> --confirm [--command-id <uuid>]`：
  - `--revision` 是 Feature 聚合 expectedRevision（唯一 CAS 入口）；
    `--operation` 是 UUID v4 的 Git 操作身份；`--confirm` 必填（缺确认
    退出码 2，零副作用）；
- 公共：`--data-root <abs>`、`--json`、写命令的 `--command-id <uuid>`
  （幂等/恢复：同一信封重放返回原回执，replayed=true）。

## 3. 结构化输出（--json 信封 result）

- `feature.delivery`：`feature`、`run`、`axes`（`tasks`/`verification`/
  `approval`/`delivery` 四轴分别展示，保留 Feature/Run/operation 与证据
  引用）、`outcome`（status/executionStage/reason/nextStep/identities）与
  派生 `completed`；`completed` 恒等于 `outcome.status==="completed"`——
  所有 Task 通过但最终失败（final_verification_failed）、等待批准
  （awaiting_approval）、no_change、待核对（delivery_uncertain/pending）
  与证据不全（evidence_incomplete）一律 `completed=false`；
- `git.operations`：`records[]`（每条含意图边界 expectedHead/candidateTree、
  实际事实 actualCommit/actualParent/exitCode/durationMs、回执在场性
  receiptRecorded 与派生 `committed`）、`nextCursor`、`limit`；
- `git.operation`：`record` + `intentDigest`/`codeDigest`/
  `deliveryPolicyDigest`/`message`/`gitIdentity`（用户确认身份来源）；
  `committed` 要求 `status==="succeeded"` 且 `deliveryStatus==="succeeded"`
  且存在已核对 `actualParent`——pending（回执缺失）、unknown（待核对）、
  no_change（无变更终态）与 failed 恒为 `committed=false`，绝不把待核对
  或无变更显示为已提交；
- `feature.final-approve`：`commandId`、`replayed`、`task`、`item`
  （status/planDigest/codeDigest）、`decision:"approve"`、
  `runtimeCalled=false`/`executionStarted=false` 与说明 `note`；
- `feature.finalize`：`commandId`、`replayed`、`featureId`/`runId`/`batchId`/
  `gitOperationId`、`outcome`、`reason`、`deliveryStatus` 与派生 `delivered`；
  `delivered` 恒等于 `outcome==="completed"` 且
  `deliveryStatus==="succeeded"`——命令 completed 只表示收尾请求已处理，
  awaiting_approval/failed/partial 都不是交付成功。

## 4. 错误与退出码

- 退出码沿用既有约定：0 成功；1 业务拒绝/操作失败；2 输入错误；
  3 连接/协议错误；
- 本地拒绝（退出码 2）：非法 project/feature/run/batch/operation 身份、
  非法摘要/revision、缺 `--confirm`、父级缺失或同现、伪造主体/凭据参数；
- 服务端拒绝（退出码 1）：业务拒绝回执（如 feature_revision_conflict、
  deadline_exceeded 等稳定原因，保留 commandId 便于查回执）、未可信装配
  delivery 能力 `unsupported`、跨项目/不存在折叠 `not_found`；
- 区分请求被接受与业务交付成功：completed 回执（退出码 0）只表示命令已
  处理；交付是否成功以 `delivered`/`completed` 派生标志与
  `feature delivery` 分轴查询为准。

## 5. 边界

- 批准不自动运行：人工批准只记录决定事实，不启动最终检查、不提交、不调用
  Runtime；交付必须另行显式 `feature finalize --confirm` 请求；
- 只支持获准的最终提交：不支持 push/PR/自动合并或任意分支操作；
- 失败保留现场：最终检查或提交失败保留有效 Task 历史与 worktree，不自动
  重跑编码；需要代码修复时先明确失效范围与返工授权；
- 本命令面不提供 P03-9 的新 Run 收尾重试控制。
