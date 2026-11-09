# P07-4 结果查询与本地通知操作说明（F-010）

适用版本：P07-4 分支 `feat/2026-10-29-21-59-22_p07-4-hook`（F-010 收尾，基线 `29147fa`）。
本文面向 owner/运维，说明结果诊断查询、本地通知状态与有限重试、重启语义、
审计引用、脱敏与平台限制。命令均以仓库内 Node 22.19.0 / npm 10.9.3 为准；
示例中的 `<dataRoot>` 是 Host 数据根绝对路径，`<projectId>` 为项目 UUID。

## 1. 结果诊断查询（公开只读面）

```bash
# 按 Batch / Run / Attempt / Work Session 定位（四选一，键集分页）
app execution result-diagnostics --project <projectId> --run <runId> --json
app execution result-diagnostics --project <projectId> --batch <batchId> --json
app execution result-diagnostics --project <projectId> --attempt <attemptId> --json
app execution result-diagnostics --project <projectId> --session <sessionId> --json
app execution result-diagnostics --project <projectId> --run <runId> --limit 50 --cursor <cursor> --json
```

查询零写入、零认领、零重试；多次查询结果一致。不存在与越权目标沿用既有公开
错误规则（`forbidden` / `not_found` / `invalid_input`），游标绑定项目与父级范围，
跨范围重放拒绝。

### 结果轴解释（三轴分离，勿混读）

| 轴 | 字段 | 含义 |
| --- | --- | --- |
| Runtime 轴 | `runtime.attemptStatus` | Runtime 执行事实（executing/succeeded/failed/interrupted/cancelled…）。`succeeded` **不等于** Task 通过。 |
| Task 验收轴 | `task.verification`（batchId/status）、`codeRef` | 受控检查批次与代码提交引用。只有验证批次 `passed` 且收尾落账才是 Task 通过。 |
| Feature 交付轴 | `feature.deliveryStatus` | 最终交付状态（`not_requested`/交付中/已交付等）。未进入交付决策时如实 `not_requested`，不是失败。 |

- **代码引用**：`gitOperationRefs`（真实 Git 回执 operationId/actual_commit）与 `codeRef`。
- **检查引用**：`task.verification.batchId`（验证批次，形如 `p07-4-verif-<attemptId>`）
  与其下的检查输出制品（见第 4 节审计引用）。
- **Token（用量）**：`usage` 子树来自 Runtime 归一化用量；未知 Token 保持 `null`，
  不填零、不重复叠加 Attempt/Session/上级汇总。FakeRuntime 或无用量来源时恒为 null。
- **记录缺口**：结果证据与 Work 记录覆盖按 missing/corrupt 细分原因展示（见
  `docs/phases/p07/p07-2-f005-recording-supervision.md` 等 P07-2 文档）；缺文件明确
  `missing`、内容漂移明确 `corrupt`，不伪造 `complete`。
- **停止/阻塞原因与待处理动作**：`resultEvidenceRef`、`rework`、运行恢复查询
  （`app execution recovery <runId> --project <projectId> --json`）给出停止原因与
  `nextSteps`（如 `execution.resume`）。

## 2. 本地通知查询（公开只读面）

```bash
# 列表（实体 Task/Run/Feature 至多一个；状态筛选可选；键集分页）
app notifications list --project <projectId> --task t-1 --json
app notifications list --project <projectId> --run <runId> --status retry_scheduled --json
app notifications list --project <projectId> --feature <featureId> --json
# 单条详情（含有界执行审计链与最近结果）
app notifications get <deliveryId> --project <projectId> --json
```

- 通知只含**脱敏冻结摘要**（kind ∈ `task_terminal` / `task_action_required` /
  `run_ended` / `feature_finalized` / `feature_finalization_blocked`），
  摘要键值有界（单值 256 字符，整体 4 KiB），不含正文、路径、令牌或凭据。
- 实体筛选由摘要冻结键派生（task→taskId、run→runId、feature→featureId）；
  `--run` 只匹配 run 实体通知（run 终态事件），Task 通知用 `--task` 查询。
- 详情 `receipt` 是渠道回执（本地渠道为确定性持久回执），`audit` 为有界执行链。

### 发送状态（五类）

| 状态 | CLI 文本 | 含义 |
| --- | --- | --- |
| `pending` | 等待发送 | 已生成、尚未被认领（含归档项目中保留的行）。 |
| `in_flight` | 发送中 | 已认领、投递在途（持 fencing 代次）。 |
| `retry_scheduled` | 待重试 | 上次失败，已持久化失败记录并排定下次尝试时间。 |
| `delivered` | 已发送 | 成功回执已持久化；不会重发。 |
| `exhausted` | 停止重试 | 尝试次数达上限，停止重试；事实行保留可查。 |

## 3. 有限重试政策（产品默认，写入路径不接受调用方覆盖）

- 最大尝试次数 `maxAttempts = 4`（接口硬上限 16）。
- 退避：失败后 `baseDelayMs = 60s` 起，每次乘 `delayFactor = 8`（60s → 8min → …），
  单次封顶 `maxDelayMs = 1h`。
- 每次尝试恰好一条本地结果记录（deliveryId + attempt 唯一）；同一次尝试的结果
  写入幂等，不重复记账。
- 项目进入 archiving/archived 后 delivery 事实行保留但不被认领（不伪造送达）。

## 4. 审计引用（可回溯身份）

| 引用 | 出处 | 核对 |
| --- | --- | --- |
| `deliveryId` / `eventId` / `eventSequence` | 通知列表/详情 | 源事件为唯一事实；(eventId, channelId) 唯一，重复事件不重复建 delivery。 |
| `attemptId` / `runId` | 摘要、结果诊断 | 与 Run/Attempt 轴一致。 |
| `resultRef` | task_terminal 摘要 | 验证批次引用（`p07-4-verif-…`），其检查输出为受控制品。 |
| 检查输出制品 | `check_results.output_artifact_id` | 受控文件（内容摘要/大小可核），正文按制品引用按需读取、有界。 |
| 回执/失败原因 | `receipt` / `lastFailureReason` | 单次尝试的持久结果记录；失败原因有界 256 字符。 |
| delivery 结果轴 | 结果诊断 `task.verification`、`gitOperationRefs` | 与通知互相印证，但通知不改变业务结果。 |

## 5. 重启语义

- Host 启动（锁 + Schema + 恢复核对完成后）自动启动通知运行时：立即补扫积压
  事件，此后周期补扫（持久水位，内存唤醒只是优化）。
- **重启只继续通知，不重跑业务**：通知活动不创建 Run/Attempt、不推进 Task、
  不消费预算。业务 Run 的 restart_recovery/interrupted 是独立的执行恢复语义
  （见 P07-1 文档），与通知无关。
- 同一源事件和渠道在任何重启后仍只有一条 delivery；`delivered` 行不重发；
  `retry_scheduled` 到期后续投；未到期不提前。
- 停止期间：停止新认领，有限预算等待在途发送收尾；未确认时关闭被拒绝并保留
  in_flight 现场与锁（不吞掉未确认失败），收尾后重试关闭。
- 备份/恢复后通知水位、delivery、回执与制品引用与备份时点一致；已发送记录
  不重复生成。备份与恢复操作见 `docs/phases/p07/p07-3-data-lifecycle-operations.md`。

## 6. 脱敏与平台限制

- 通知摘要与查询输出不含数据根路径、仓库路径、令牌或凭据；失败原因只保留
  分类码（如 `channel_failed` / `send_timeout`），不回显错误正文。
- 正式验收平台：**macOS**；Windows/WSL/Linux 不作为当前通过条件。
- 当前唯一内置渠道是 `local-results`（SQLite 持久结果即本地结果记录）。
  **不声称已实现**：外部 Webhook、系统/桌面通知、托管 Chat、远端恰好一次投递。
  外部渠道需经版本化端口单独扩展与验收。
- 本地渠道的“已发送”表示本地结果记录与回执已持久化；对远端系统不承诺
  exactly-once。进程崩溃后确认丢失的在途发送（in_flight 孤儿）按恢复政策
  由可信控制层核验，不自动重复外部副作用。

## 7. 已知边界

- 归档项目恢复为 active 后，到期 delivery 照常送达；归档/删除的边界行为以
  `docs/phases/p07/p07-3-data-lifecycle-operations.md` 为准。
- 通知摘要损坏的持久行经查询 fail-closed（结构化 `corrupt` 错误），不伪造成功
  也不静默跳过；缺失 delivery 明确 `not_found`。
- 公开事件面（events list）为白名单契约；工作流内部事件（如 `work.session.updated`）
  不经公开事件面映射，通知投影将其作为已知内部事件只推进扫描位置。
